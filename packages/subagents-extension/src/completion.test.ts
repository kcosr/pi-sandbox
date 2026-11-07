import type {
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installDelivery, RESULT_MESSAGE_TYPE, type PendingDelivery } from "./delivery.js";

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;
const result = (id: string, content = id): PendingDelivery => ({
  eventId: id,
  agentId: "child",
  taskId: id,
  content,
});

function fixture(waitForChildren = true) {
  const handlers = new Map<string, Handler>();
  const entries: SessionEntry[] = [];
  let signal = new AbortController();
  let active = 0;
  let pending: PendingDelivery[] = [];
  let healthError: Error | undefined;
  let acknowledgementError: Error | undefined;
  let cleanupError: Error | undefined;
  let releaseCleanup: (() => void) | undefined;
  let change: (() => void) | undefined;
  let waiters = 0;
  const acknowledge = vi.fn((id: string) => {
    if (acknowledgementError) throw acknowledgementError;
    pending = pending.filter((item) => item.eventId !== id);
  });
  const abortParent = vi.fn(() => signal.abort());
  const hasPendingMessages = vi.fn(() => false);
  const context = {
    sessionManager: { getEntries: () => entries, getSessionId: () => "parent" },
    get signal() {
      return signal.signal;
    },
    isIdle: () => false,
    hasPendingMessages,
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
        waiters += 1;
        const check = () => {
          if (!abort.aborted && !healthError && active > 0) return;
          waiters -= 1;
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
      ...(waitForChildren
        ? {
            completion: {
              active: () => active,
              assertHealthy: () => {
                if (healthError) throw healthError;
              },
              waitForIdle,
              quiesce,
            },
          }
        : {}),
    },
  );
  delivery.updateContext(context);
  return {
    context,
    abortParent,
    get signal() {
      return signal;
    },
    entries,
    delivery,
    acknowledge,
    sendMessage,
    quiesce,
    waitForIdle,
    hasPendingMessages,
    get waiters() {
      return waiters;
    },
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
    set cleanupError(value: Error | undefined) {
      cleanupError = value;
    },
    async newRun() {
      signal = new AbortController();
      await handlers.get("agent_start")?.({}, context);
      await handlers.get("turn_start")?.({}, context);
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
  afterEach(() => vi.useRealTimers());

  it("checks newly queued input once per second and releases only the child wait", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.active = 1;
    let settled = false;
    const boundary = f.fire("turn_end").then((value) => {
      settled = true;
      return value;
    });
    const initialChecks = f.hasPendingMessages.mock.calls.length;
    expect(f.waiters).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(f.hasPendingMessages).toHaveBeenCalledTimes(initialChecks);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.hasPendingMessages).toHaveBeenCalledTimes(initialChecks + 1);
    expect(f.waitForIdle).toHaveBeenCalledOnce();
    expect(f.waiters).toBe(1);

    f.hasPendingMessages.mockReturnValue(true);
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    // Pi drains its own queues after turn_end. A queue-only wake must not ask for
    // a context-only model continuation or cancel any still-running children.
    expect(await boundary).toBeUndefined();
    expect(f.waiters).toBe(0);
    expect(f.waitForIdle.mock.calls[0]![0].aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.quiesce).not.toHaveBeenCalled();
    expect(f.abortParent).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();

    f.hasPendingMessages.mockReturnValue(false);
    await f.fire("turn_start");
    const nextBoundary = f.fire("turn_end");
    expect(f.waiters).toBe(1);
    expect(vi.getTimerCount()).toBe(1);
    f.active = 0;
    expect(await nextBoundary).toBeUndefined();
    expect(f.waiters).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rechecks queued input immediately after subscribing to child completion", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.active = 1;
    f.hasPendingMessages
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    expect(await f.fire("turn_end")).toBeUndefined();
    expect(f.waitForIdle).toHaveBeenCalledOnce();
    expect(f.waiters).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.quiesce).not.toHaveBeenCalled();
    expect(f.abortParent).not.toHaveBeenCalled();
    f.delivery.dispose();
  });

  it("delivers child completion immediately without waiting for the input timer", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.active = 1;
    const boundary = f.fire("turn_end");
    const checks = f.hasPendingMessages.mock.calls.length;
    await vi.advanceTimersByTimeAsync(250);
    f.pending = [result("finished")];
    f.active = 0;
    expect((await boundary)?.entries).toHaveLength(1);
    expect(f.waiters).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(f.hasPendingMessages).toHaveBeenCalledTimes(checks);
    expect(f.abortParent).not.toHaveBeenCalled();
  });

  it.each(["idle", "tools", "continuation", "queued", "provider-error", "default"])(
    "does not arm an input timer outside a child wait: %s",
    async (kind) => {
      vi.useFakeTimers();
      const f = fixture(kind !== "default");
      if (kind !== "idle") f.active = 1;
      if (kind === "queued") f.hasPendingMessages.mockReturnValue(true);
      const timer = vi.spyOn(globalThis, "setTimeout");
      try {
        await f.fire(
          "turn_end",
          kind === "tools"
            ? { message: { role: "assistant", content: [{ type: "toolCall" }] } }
            : kind === "continuation"
              ? { continue: true }
              : kind === "provider-error"
                ? { outcome: "error" }
                : {},
        );
        expect(timer).not.toHaveBeenCalled();
        expect(f.waitForIdle).not.toHaveBeenCalled();
        const checks = f.hasPendingMessages.mock.calls.length;
        f.delivery.tick();
        await vi.advanceTimersByTimeAsync(2_000);
        expect(f.hasPendingMessages).toHaveBeenCalledTimes(checks);
        expect(vi.getTimerCount()).toBe(0);
      } finally {
        timer.mockRestore();
        f.delivery.dispose();
      }
    },
  );

  it.each(["pending-input", "child-health"])(
    "aborts explicitly and removes the timer and child waiter after %s fails",
    async (kind) => {
      vi.useFakeTimers();
      const f = fixture();
      f.active = 1;
      const waiting = f.fire("turn_end");
      const failure = expect(waiting).rejects.toThrow(
        /checking queued input failed|saving result failed/,
      );
      if (kind === "pending-input") {
        f.hasPendingMessages.mockImplementation(() => {
          throw new Error("checking queued input failed");
        });
        await vi.advanceTimersByTimeAsync(1_000);
      } else f.healthError = new Error("saving result failed");
      await failure;
      expect(f.waiters).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
      const checks = f.hasPendingMessages.mock.calls.length;
      await vi.advanceTimersByTimeAsync(2_000);
      expect(f.hasPendingMessages).toHaveBeenCalledTimes(checks);
      expect(f.quiesce).toHaveBeenCalledOnce();
      expect(f.abortParent).toHaveBeenCalled();
      expect(f.sendMessage).not.toHaveBeenCalled();
    },
  );

  it("waits for staggered children, then requires a result turn", async () => {
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
    vi.useFakeTimers();
    const f = fixture();
    f.active = 1;
    f.holdCleanup();
    let settled = false;
    const boundary = f.fire("turn_end").then(() => {
      settled = true;
    });
    f.signal.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.quiesce).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    expect(f.waiters).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
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

  it("allows Pi retry boundaries and stops children after a final parent error without poisoning the next run", async () => {
    const f = fixture();
    f.active = 1;
    f.pending = [result("one")];
    expect(await f.fire("turn_end", { outcome: "error" })).toBeUndefined();
    expect(f.abortParent).not.toHaveBeenCalled();
    expect(await f.fire("agent_before_settle", { outcome: "error" })).toBeUndefined();
    expect(f.quiesce).toHaveBeenCalledOnce();
    expect(f.abortParent).not.toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
    await f.fire("agent_settled", { aborted: false });
    await f.newRun();
    await f.fire("turn_end");
    await f.fire("agent_before_settle");
    expect(f.abortParent).not.toHaveBeenCalled();
  });

  it("preserves settled results across a parent provider failure for the next prompt", async () => {
    const f = fixture();
    f.pending = [result("one"), result("two", "Outcome: failed")];
    await f.fire("turn_end", { outcome: "error" });
    await f.fire("agent_before_settle", { outcome: "error" });
    await f.fire("agent_settled", { aborted: false });
    expect(f.quiesce).not.toHaveBeenCalled();
    expect(f.acknowledge).not.toHaveBeenCalled();
    await f.newRun();
    const output = await f.fire("turn_end");
    expect(output?.continue).toBe(true);
    expect(output?.entries).toHaveLength(2);
    f.commit(output);
    await f.fire("turn_start");
    expect(f.acknowledge.mock.calls).toEqual([["one"], ["two"]]);
    expect(await f.fire("turn_end")).toBeUndefined();
    await f.fire("agent_before_settle");
    expect(f.abortParent).not.toHaveBeenCalled();
  });

  it("does not reclassify an unrelated provider failure as a subagent abort", async () => {
    const f = fixture();
    await f.fire("turn_end", { outcome: "error" });
    await f.fire("agent_before_settle", { outcome: "error" });
    await f.fire("agent_settled", { aborted: false });
    expect(f.quiesce).not.toHaveBeenCalled();
    await f.newRun();
    await f.fire("turn_end");
    await f.fire("agent_before_settle");
    expect(f.abortParent).not.toHaveBeenCalled();
  });

  it("reports bounded abort-cleanup failure once and permits a later healthy run", async () => {
    const f = fixture();
    f.active = 1;
    f.cleanupError = new Error("Subagent shutdown is still waiting for active work to settle");
    const waiting = f.fire("turn_end");
    const failure = expect(waiting).rejects.toThrow(/Subagent completion/);
    f.signal.abort();
    await failure;
    // Pi already emitted the boundary exception; settlement must not report it twice.
    await expect(f.fire("agent_settled", { aborted: true })).resolves.toBeUndefined();
    f.cleanupError = undefined;
    f.active = 0;
    const aborted = f.abortParent.mock.calls.length;
    await f.newRun();
    await f.fire("turn_end");
    await f.fire("agent_before_settle");
    expect(f.abortParent).toHaveBeenCalledTimes(aborted);
  });

  it("reports a genuine sticky controller fault on each attempted run", async () => {
    const f = fixture();
    f.healthError = new Error("state persistence failed");
    await expect(f.fire("turn_end")).rejects.toThrow(/state persistence failed/);
    await f.fire("agent_settled", { aborted: true });
    await expect(f.newRun()).rejects.toThrow(/state persistence failed/);
    await f.fire("agent_settled", { aborted: true });
    expect(f.abortParent).toHaveBeenCalledTimes(2);
  });

  it("waits when finalized tool results terminate the parent batch", async () => {
    const f = fixture();
    f.active = 1;
    await f.fire("tool_execution_end", { toolCallId: "finish", result: { terminate: true } });
    const waiting = f.fire("turn_end", {
      message: { role: "assistant", content: [{ type: "toolCall", id: "finish" }] },
    });
    expect(f.waitForIdle).toHaveBeenCalledOnce();
    f.pending = [result("finished")];
    f.active = 0;
    const output = await waiting;
    expect(output?.continue).toBe(true);
    f.commit(output);
    await f.fire("turn_start");
    await f.fire("turn_end");
    await f.fire("agent_before_settle");
    expect(f.abortParent).not.toHaveBeenCalled();
  });

  it("disposal wakes an outstanding wait without scheduling another parent run", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.active = 1;
    const boundary = f.fire("turn_end");
    f.delivery.dispose();
    expect(await boundary).toBeUndefined();
    expect(f.waiters).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.abortParent).toHaveBeenCalled();
    expect(f.sendMessage).not.toHaveBeenCalled();
  });
});
