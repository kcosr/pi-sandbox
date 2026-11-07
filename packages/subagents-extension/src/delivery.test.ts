import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
afterEach(() => vi.useRealTimers());
import type {
  BoundaryResult,
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { installDelivery, RESULT_MESSAGE_TYPE, type PendingDelivery } from "./delivery.js";

type Handler = (event: Record<string, unknown>, context: ExtensionContext) => unknown;
const result = (suffix = "1"): PendingDelivery => ({
  eventId: `event-${suffix}`,
  agentId: "child",
  taskId: `task-${suffix}`,
  content: `Result ${suffix}; 0 active children.`,
});

function fixture(initial: PendingDelivery[] = [result()]) {
  const handlers = new Map<string, Set<Handler>>();
  const entries: SessionEntry[] = [];
  const sent: Array<{
    message: Parameters<ExtensionAPI["sendMessage"]>[0];
    options: unknown;
  }> = [];
  const acknowledged: string[] = [];
  const errors: unknown[] = [];
  const notices: string[] = [];
  let sendError: Error | undefined;
  let pending = initial;
  let idle = false;
  let disarmed = 0;
  let signal: AbortSignal | undefined;
  let parentSession = "parent";
  const context = {
    sessionManager: {
      getEntries: () => entries,
      getSessionId: () => parentSession,
    },
    isIdle: () => idle,
    get signal() {
      return signal;
    },
  } as unknown as ExtensionContext;
  const pi = {
    on(name: string, handler: Handler) {
      const list = handlers.get(name) ?? new Set<Handler>();
      handlers.set(name, list);
      list.add(handler);
      return () => list.delete(handler);
    },
    sendMessage(message: Parameters<ExtensionAPI["sendMessage"]>[0], options: unknown) {
      sent.push({ message, options });
      if (sendError) throw sendError;
      idle = false;
    },
  } as unknown as ExtensionAPI;
  const delivery = installDelivery(pi, {
    getPending: () => pending,
    acknowledge(id) {
      acknowledged.push(id);
      pending = pending.filter((item) => item.eventId !== id);
    },
    disarm() {
      disarmed++;
      const count = pending.length;
      pending = [];
      return count;
    },
    onNotice(message) {
      notices.push(message);
    },
    onError(error) {
      errors.push(error);
    },
  });
  delivery.updateContext(context);
  return {
    delivery,
    entries,
    sent,
    acknowledged,
    errors,
    notices,
    context,
    set sendError(value: Error | undefined) {
      sendError = value;
    },
    get disarmed() {
      return disarmed;
    },
    set idle(value: boolean) {
      idle = value;
    },
    set pending(value: PendingDelivery[]) {
      pending = value;
    },
    set signal(value: AbortSignal | undefined) {
      signal = value;
    },
    set parentSession(value: string) {
      parentSession = value;
    },
    emit(name: string, event: Record<string, unknown> = {}) {
      return [...(handlers.get(name) ?? [])].map((handler) => handler(event, context));
    },
    boundary(name = "turn_end", outcome = "completed", existing: unknown[] = []) {
      return this.emit(name, {
        type: name,
        entries: existing,
        continue: false,
        outcome,
      })[0] as BoundaryResult | undefined;
    },
    persist(item: PendingDelivery = result()) {
      entries.push({
        type: "custom_message",
        id: `entry-${entries.length}`,
        parentId: null,
        timestamp: new Date().toISOString(),
        customType: RESULT_MESSAGE_TYPE,
        content: item.content,
        display: true,
        details: {
          eventId: item.eventId,
          agentId: item.agentId,
          taskId: item.taskId,
        },
      });
    },
  };
}

test("busy delivery appends after-tools entries and acknowledges only persisted transcript", () => {
  const f = fixture([result(), result("2")]);
  f.delivery.tick();
  assert.equal(f.sent.length, 0);
  const prior = { type: "custom", customType: "another-extension", data: {} };
  const output = f.boundary("turn_end", "completed", [prior]);
  assert.equal(output?.continue, true);
  assert.equal(output?.entries?.length, 3);
  assert.deepEqual(output?.entries?.[0], prior);
  assert.deepEqual(f.acknowledged, []);
  f.persist();
  f.persist(result("2"));
  f.delivery.tick();
  assert.deepEqual(f.acknowledged, ["event-1", "event-2"]);
  assert.equal(f.boundary(), undefined);
});

test("idle delivery wakes once, then remaining results join a safe boundary", () => {
  const f = fixture([result(), result("2")]);
  f.idle = true;
  f.delivery.tick();
  f.delivery.tick();
  assert.equal(f.sent.length, 1);
  assert.deepEqual(f.sent[0]?.options, {
    deliverAs: "steer",
    triggerTurn: true,
  });
  assert.deepEqual(f.acknowledged, []);
  f.persist();
  const output = f.boundary("agent_before_settle");
  assert.equal(output?.entries?.length, 1);
  assert.deepEqual(output?.entries?.[0], {
    type: "custom_message",
    customType: RESULT_MESSAGE_TYPE,
    content: result("2").content,
    display: true,
    details: { eventId: "event-2", agentId: "child", taskId: "task-2" },
  });
});

test("reload reconciles append-before-ack crash without sending another result", () => {
  const f = fixture();
  f.persist();
  f.idle = true;
  f.delivery.tick();
  assert.deepEqual(f.acknowledged, ["event-1"]);
  assert.equal(f.sent.length, 0);
});

test("a message-end notification is not treated as a persistence acknowledgment", () => {
  const f = fixture();
  f.idle = true;
  f.delivery.tick();
  f.emit("message_end", { message: { role: "custom", ...f.sent[0]?.message } });
  f.delivery.tick();
  assert.deepEqual(f.acknowledged, []);
  f.persist();
  f.delivery.tick();
  assert.deepEqual(f.acknowledged, ["event-1"]);
});

test("idle startup failure retries after a backoff rather than every tick", () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(10_000);
  const f = fixture();
  f.idle = true;
  f.delivery.tick();
  // The run failed before the custom message was appended to its transcript.
  f.idle = true;
  f.delivery.tick();
  f.delivery.tick();
  assert.equal(f.sent.length, 1);
  vi.setSystemTime(11_999);
  f.delivery.tick();
  assert.equal(f.sent.length, 1);
  vi.setSystemTime(12_000);
  f.delivery.tick();
  assert.equal(f.sent.length, 2);
  assert.deepEqual(f.acknowledged, []);
});

test("uncommitted boundary results are retried at the next boundary", () => {
  const f = fixture();
  assert.equal(f.boundary()?.entries?.length, 1);
  // Another extension replaced the entries, or Pi could not commit them.
  assert.equal(f.boundary("agent_before_settle")?.entries?.length, 1);
  assert.deepEqual(f.acknowledged, []);
});

test("cancellation removes old task eligibility before a boundary; resumed task can deliver", () => {
  const f = fixture();
  f.delivery.tick();
  f.pending = [];
  assert.equal(f.boundary(), undefined);
  f.pending = [result("2")];
  f.persist(result());
  const output = f.boundary();
  assert.equal(output?.entries?.length, 1);
  assert.deepEqual(f.acknowledged, []);
  assert.equal(
    (output?.entries?.[0] as { details?: { taskId: string } }).details?.taskId,
    "task-2",
  );
});

test("parent abort disarms immediately and cannot be revived by later idle ticks", () => {
  const f = fixture();
  const abort = new AbortController();
  f.signal = abort.signal;
  f.emit("agent_start");
  abort.abort();
  assert.equal(f.disarmed, 1);
  f.emit("agent_settled", { aborted: true });
  f.idle = true;
  f.delivery.tick();
  assert.equal(f.disarmed, 1);
  assert.equal(f.sent.length, 0);
  assert.equal(f.boundary("turn_end", "aborted"), undefined);
  // A new task in a new parent run may explicitly rearm result delivery.
  f.signal = new AbortController().signal;
  f.emit("agent_start");
  f.pending = [result("2")];
  assert.equal(f.boundary()?.entries?.length, 1);
});

test("settlement aborted flag fences work even when an abort signal was unavailable", () => {
  const f = fixture();
  f.emit("agent_settled", { aborted: true });
  f.idle = true;
  f.delivery.tick();
  assert.equal(f.disarmed, 1);
  assert.equal(f.sent.length, 0);
});

test("transcript acknowledgment requires event, agent, and task identity", () => {
  const f = fixture();
  f.persist({ ...result(), taskId: "old-task" });
  assert.equal(f.boundary()?.entries?.length, 1);
  assert.deepEqual(f.acknowledged, []);
});

test("shutdown disposal removes hooks and abort listeners", () => {
  const f = fixture();
  const abort = new AbortController();
  f.signal = abort.signal;
  f.emit("agent_start");
  f.emit("session_shutdown", { reason: "reload" });
  abort.abort();
  f.idle = true;
  f.delivery.tick();
  assert.equal(f.disarmed, 0);
  assert.equal(f.sent.length, 0);
  assert.equal(f.boundary(), undefined);
});

test("a controller refuses to deliver old work into a different parent session", () => {
  const f = fixture();
  f.parentSession = "another-parent";
  assert.throws(() => f.delivery.updateContext(f.context), /another parent session/);
  f.idle = true;
  f.delivery.tick();
  assert.equal(f.sent.length, 0);
  assert.equal(f.errors.length, 1);
});

test.each(["asynchronous startup", "synchronous send"])(
  "idle retries back off and pause after repeated %s failure until a successful parent turn",
  (failure) => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(0);
    const f = fixture();
    if (failure === "synchronous send") f.sendError = new Error("fixture cannot start");
    f.idle = true;
    f.delivery.tick();
    for (const [index, delay] of [2000, 4000, 8000, 16000, 30000].entries()) {
      f.idle = true;
      f.delivery.tick();
      const now = Date.now();
      vi.setSystemTime(now + delay - 1);
      f.delivery.tick();
      assert.equal(f.sent.length, index + 1);
      vi.setSystemTime(now + delay);
      f.delivery.tick();
      assert.equal(f.sent.length, index + 2);
    }
    f.idle = true;
    f.delivery.tick();
    assert.equal(f.notices.length, 1);
    assert.match(f.notices[0]!, /paused.*parent/);
    assert.match(f.notices[0]!, /inspect_agent/);
    vi.setSystemTime(Date.now() + 60 * 60 * 1000);
    f.delivery.tick();
    f.delivery.tick();
    assert.equal(f.sent.length, 6);
    assert.equal(f.notices.length, 1);
    f.emit("agent_start");
    assert.equal(f.boundary("agent_before_settle", "error"), undefined);
    f.delivery.tick();
    assert.equal(f.sent.length, 6);
    // A genuine successful parent turn releases paused results at its safe boundary.
    assert.equal(f.boundary("agent_before_settle", "completed")?.entries?.length, 1);
    f.persist();
    f.delivery.tick();
    assert.deepEqual(f.acknowledged, ["event-1"]);
  },
);

test("parent abort notifies once that existing running tasks lose automatic callbacks", () => {
  const f = fixture([result(), result("2")]);
  const abort = new AbortController();
  f.signal = abort.signal;
  f.emit("agent_start");
  abort.abort();
  f.emit("agent_settled", { aborted: true });
  f.idle = true;
  f.delivery.tick();
  assert.equal(f.notices.length, 1);
  assert.match(f.notices[0]!, /2 existing subagent tasks, including running tasks/);
  assert.match(f.notices[0]!, /Running tasks continue/);
  assert.match(f.notices[0]!, /\/subagents or inspect_agent/);
  assert.equal(f.sent.length, 0);
});
