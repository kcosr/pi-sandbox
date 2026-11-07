import type {
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { installDelivery, RESULT_MESSAGE_TYPE, type PendingDelivery } from "./delivery.js";

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;
const result = (id: string, content = id): PendingDelivery => ({
  eventId: id,
  agentId: "child",
  taskId: id,
  content,
});

function fixture() {
  const handlers = new Map<string, Handler>();
  const entries: SessionEntry[] = [];
  const signal = new AbortController();
  let active = 0;
  let pending: PendingDelivery[] = [];
  let healthError: Error | undefined;
  let acknowledgementError: Error | undefined;
  let cleanupError: Error | undefined;
  let releaseCleanup: (() => void) | undefined;
  let change: (() => void) | undefined;
  const acknowledge = vi.fn((id: string) => {
    if (acknowledgementError) throw acknowledgementError;
    pending = pending.filter((item) => item.eventId !== id);
  });
  const abortParent = vi.fn(() => signal.abort());
  const context = {
    sessionManager: { getEntries: () => entries, getSessionId: () => "parent" },
    signal: signal.signal,
    isIdle: () => false,
    hasPendingMessages: () => false,
    abort: abortParent,
  } as unknown as ExtensionContext;
  const sendMessage = vi.fn();
  const quiesce = vi.fn(async () => {
    pending = [];
    if (releaseCleanup)
      await new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });
    if (cleanupError) throw cleanupError;
    active = 0;
    change?.();
  });
  const waitForIdle = vi.fn(
    (abort: AbortSignal) =>
      new Promise<void>((resolve, reject) => {
        const check = () => {
          if (!abort.aborted && !healthError && active > 0) return;
          change = undefined;
          abort.removeEventListener("abort", check);
          if (healthError) reject(healthError);
          else if (abort.aborted)
            reject(abort.reason instanceof Error ? abort.reason : new Error("aborted"));
          else resolve();
        };
        change = check;
        abort.addEventListener("abort", check, { once: true });
        check();
      }),
  );
  const delivery = installDelivery(
    {
      on: (name: string, handler: Handler) => {
        handlers.set(name, handler);
        return () => handlers.delete(name);
      },
      sendMessage,
    } as unknown as ExtensionAPI,
    {
      getPending: () => pending,
      acknowledge,
      disarm: () => {
        const count = pending.length;
        pending = [];
        return count;
      },
      onNotice: () => undefined,
      completion: {
        active: () => active,
        assertHealthy: () => {
          if (healthError) throw healthError;
        },
        waitForIdle,
        quiesce,
      },
    },
  );
  delivery.updateContext(context);
  return {
    context,
    abortParent,
    signal,
    entries,
    delivery,
    acknowledge,
    sendMessage,
    quiesce,
    waitForIdle,
    set active(value: number) {
      active = value;
      change?.();
    },
    set pending(value: PendingDelivery[]) {
      pending = value;
    },
    set healthError(value: Error) {
      healthError = value;
      change?.();
    },
    set acknowledgementError(value: Error) {
      acknowledgementError = value;
    },
    set cleanupError(value: Error) {
      cleanupError = value;
    },
    holdCleanup() {
      releaseCleanup = () => undefined;
    },
    finishCleanup() {
      releaseCleanup?.();
    },
    async fire(name: string, overrides: Record<string, unknown> = {}) {
      return (await handlers.get(name)?.(
        {
          outcome: "completed",
          entries: [],
          continue: false,
          message: { role: "assistant", content: [{ type: "text", text: "finished" }] },
          ...overrides,
        },
        context,
      )) as BoundaryResult | undefined;
    },
    commit(output: BoundaryResult | undefined) {
      for (const entry of output?.entries ?? []) entries.push(entry as SessionEntry);
    },
  };
}

describe("opt-in parent completion", () => {
  it("waits for staggered children without polling, then requires a result turn", async () => {
    const f = fixture();
    f.active = 2;
    let settled = false;
    const boundary = f.fire("turn_end").then((value) => {
      settled = true;
      return value;
    });
    f.pending = [result("one")];
    f.active = 1;
    await Promise.resolve();
    expect(settled).toBe(false);
    expect(f.waitForIdle).toHaveBeenCalledTimes(1);
    f.pending = [result("one"), result("two", "Outcome: failed")];
    f.active = 0;
    const output = await boundary;
    expect(output?.continue).toBe(true);
    expect(output?.entries).toHaveLength(2);
    expect(f.acknowledge).not.toHaveBeenCalled();
    f.commit(output);
    await f.fire("turn_start");
    expect(f.acknowledge.mock.calls).toEqual([["one"], ["two"]]);
    expect(await f.fire("turn_end")).toBeUndefined();
    expect(await f.fire("agent_before_settle")).toBeUndefined();
    expect(f.abortParent).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("repeats the wait when a continuation starts another child", async () => {
    const f = fixture();
    f.pending = [result("first")];
    f.commit(await f.fire("turn_end"));
    await f.fire("turn_start");
    f.active = 1;
    const next = f.fire("turn_end");
    f.pending = [result("next")];
    f.active = 0;
    const output = await next;
    expect(output?.entries).toHaveLength(1);
    expect(output?.entries?.[0]).toMatchObject({ details: { taskId: "next" } });
    f.commit(output);
    await f.fire("turn_start");
    await f.fire("turn_end");
    await f.fire("agent_before_settle");
    expect(f.abortParent).not.toHaveBeenCalled();
  });

  it("does not wait between the parent's natural tool turns", async () => {
    const f = fixture();
    f.active = 1;
    await f.fire("turn_end", { message: { role: "assistant", content: [{ type: "toolCall" }] } });
    expect(f.waitForIdle).not.toHaveBeenCalled();
    expect(f.abortParent).not.toHaveBeenCalled();
    f.delivery.dispose();
  });

  it("waits for suppressed cancelled tasks but sends no replacement result", async () => {
    const f = fixture();
    f.active = 1;
    const boundary = f.fire("turn_end");
    f.active = 0;
    expect(await boundary).toBeUndefined();
    await f.fire("agent_before_settle");
    expect(f.abortParent).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("abort interrupts the wait and waits for cancellation cleanup", async () => {
    const f = fixture();
    f.active = 1;
    f.holdCleanup();
    let settled = false;
    const boundary = f.fire("turn_end").then(() => {
      settled = true;
    });
    f.signal.abort();
    await Promise.resolve();
    expect(f.quiesce).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    f.finishCleanup();
    await boundary;
    await f.fire("agent_settled", { aborted: true });
    f.pending = [result("late")];
    f.delivery.tick();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["health", "cleanup"])(
    "explicitly aborts on %s failure instead of succeeding",
    async (kind) => {
      const f = fixture();
      f.active = 1;
      const boundary = f.fire("turn_end");
      const rejection = expect(boundary).rejects.toThrow(/Subagent completion/);
      if (kind === "health") f.healthError = new Error("saving result failed");
      else {
        f.cleanupError = new Error("cleanup failed");
        f.signal.abort();
      }
      await rejection;
      expect(f.abortParent).toHaveBeenCalled();
      expect(f.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("reports acknowledgement persistence failure and aborts before continuation", async () => {
    const f = fixture();
    f.pending = [result("one")];
    f.commit(await f.fire("turn_end"));
    f.acknowledgementError = new Error("acknowledgement storage failed");
    await expect(f.fire("turn_start")).rejects.toThrow(/acknowledgement storage failed/);
    expect(f.abortParent).toHaveBeenCalled();
  });

  it("rechecks generation and deduplicates persisted results after waking", async () => {
    const f = fixture();
    f.active = 1;
    const boundary = f.fire("turn_end");
    f.pending = [result("old")];
    f.pending = [result("new")];
    f.active = 0;
    const output = await boundary;
    expect(output?.entries?.[0]).toMatchObject({
      customType: RESULT_MESSAGE_TYPE,
      details: { taskId: "new" },
    });
    f.commit(output);
    await f.fire("turn_start");
    f.pending = [result("new")];
    expect(await f.fire("turn_end")).toBeUndefined();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it.each(["active", "undelivered", "unconsumed"])(
    "guards final settlement against %s work",
    async (kind) => {
      const f = fixture();
      if (kind === "active") f.active = 1;
      else {
        f.pending = [result("one")];
        if (kind === "unconsumed") f.commit(await f.fire("turn_end"));
      }
      await expect(f.fire("agent_before_settle")).rejects.toThrow(/unfinished subagent work/);
      expect(f.abortParent).toHaveBeenCalled();
    },
  );

  it("allows Pi retry boundaries but fails closed after a final parent error", async () => {
    const f = fixture();
    f.active = 1;
    f.pending = [result("one")];
    expect(await f.fire("turn_end", { outcome: "error" })).toBeUndefined();
    expect(f.abortParent).not.toHaveBeenCalled();
    await expect(f.fire("agent_before_settle", { outcome: "error" })).rejects.toThrow(
      /Parent failed/,
    );
    expect(f.abortParent).toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });

  it("disposal wakes an outstanding wait without scheduling another parent run", async () => {
    const f = fixture();
    f.active = 1;
    const boundary = f.fire("turn_end");
    f.delivery.dispose();
    expect(await boundary).toBeUndefined();
    expect(f.abortParent).toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
});
