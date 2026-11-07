import { describe, expect, it, vi } from "vitest";
import {
  SubagentActivity,
  SUBAGENT_ACTIVITY_ENTRY,
  SUBAGENT_ACTIVITY_LIMITS,
  type SubagentActivityEvent,
} from "./activity.js";
import type { SubagentSnapshot } from "./contracts.js";

const snapshot = (taskId = "task-one"): SubagentSnapshot => ({
  id: "child-one",
  taskId,
  parentSessionId: "parent",
  task: "A bounded task",
  extended: false,
  status: "running",
  activity: "thinking",
  tools: [],
  startedAt: 1,
  updatedAt: 1,
  assistant: "",
  thinking: "",
  assistantTruncated: false,
  thinkingTruncated: false,
  callback: "armed",
  sessionFile: "/unused",
  provider: "fixture",
  model: "fixture",
  reasoning: "off",
});
function fixture(forwarding = true, previous: unknown[] = []) {
  const entries = [...previous];
  const appendEntry = vi.fn((customType: string, data: unknown) =>
    entries.push({ type: "custom", customType, data }),
  );
  const diagnostic = vi.fn();
  const activity = new SubagentActivity({ appendEntry }, "parent", forwarding, entries, diagnostic);
  const events = () => entries.map((entry) => (entry as { data: SubagentActivityEvent }).data);
  return { activity, entries, appendEntry, diagnostic, events };
}
function assistant(activity: SubagentActivity, text: string, task = snapshot()) {
  activity.sessionEvent(task, {
    type: "message_end",
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "private" },
        { type: "text", text },
      ],
    },
  });
}
const entryBytes = (event: SubagentActivityEvent) =>
  Buffer.byteLength(JSON.stringify(event)) + 1024;
const serializedEntry = (event: SubagentActivityEvent) =>
  JSON.stringify({
    type: "entry_appended",
    entry: {
      type: "custom",
      id: "01234567",
      parentId: "89abcdef",
      timestamp: new Date(event.timestamp).toISOString(),
      customType: SUBAGENT_ACTIVITY_ENTRY,
      data: event,
    },
  });

describe("bounded subagent activity", () => {
  it("omits tool-call-only assistant messages and retains mixed text without false truncation", () => {
    const f = fixture();
    const toolCall = { type: "toolCall", id: "call", name: "read", arguments: { path: "file" } };
    f.activity.sessionEvent(snapshot(), {
      type: "message_end",
      message: { role: "assistant", content: [toolCall] },
    });
    expect(f.events()).toEqual([]);
    f.activity.sessionEvent(snapshot(), {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Reading now" }, toolCall],
      },
    });
    expect(f.events()).toMatchObject([
      { kind: "assistant", text: "Reading now", truncated: false },
    ]);
  });

  it("persists lifecycle changes without progress-only updates", () => {
    const f = fixture();
    const child = snapshot();
    f.activity.snapshots([child]);
    for (const activity of ["writing", "running read", "thinking"])
      f.activity.snapshots([{ ...child, activity }]);
    f.activity.snapshots([{ ...child, status: "completed", activity: "completed" }]);
    f.activity.snapshots([{ ...child, taskId: "task-two", activity: "writing" }]);
    expect(f.events()).toMatchObject([
      { kind: "lifecycle", taskId: "task-one", status: "running", activity: "thinking" },
      { kind: "lifecycle", taskId: "task-one", status: "completed" },
      { kind: "lifecycle", taskId: "task-two", status: "running", activity: "writing" },
    ]);
  });

  it("drops malformed tool identities without exhausting a task on restore", () => {
    const f = fixture();
    for (const identity of [
      {},
      { toolCallId: "call", toolName: "x".repeat(513) },
      { toolCallId: "call", toolName: "read", parentToolCallId: "" },
    ]) {
      f.activity.sessionEvent(snapshot(), { type: "tool_execution_start", ...identity, args: {} });
      f.activity.sessionEvent(snapshot(), { type: "tool_execution_end", ...identity, result: {} });
    }
    expect(f.events()).toEqual([]);
    assistant(f.activity, "first answer");
    const restored = fixture(true, f.entries);
    assistant(restored.activity, "still visible");
    expect(restored.events()).toMatchObject([
      { kind: "assistant", text: "first answer" },
      { kind: "assistant", text: "still visible" },
    ]);
  });

  it("forwards only namespaced completed text, tool events and changed lifecycle", () => {
    const f = fixture();
    const child = snapshot();
    f.activity.snapshots([child]);
    f.activity.snapshots([child]);
    f.activity.sessionEvent(child, { type: "message_update", delta: "not forwarded" });
    assistant(f.activity, "child answer");
    f.activity.sessionEvent(child, {
      type: "tool_execution_start",
      toolCallId: "call",
      toolName: "read",
      parentToolCallId: "script",
      args: { path: "file.txt" },
    });
    f.activity.sessionEvent(child, {
      type: "tool_execution_end",
      toolCallId: "call",
      toolName: "read",
      parentToolCallId: "script",
      isError: false,
      result: {
        content: [
          { type: "text", text: "file contents" },
          { type: "image", data: "BINARY" },
        ],
        details: { private: "OMIT" },
      },
    });
    f.activity.snapshots([{ ...child, status: "completed", activity: "completed" }]);
    expect(f.events().map((event) => event.kind)).toEqual([
      "lifecycle",
      "assistant",
      "tool_start",
      "tool_end",
      "lifecycle",
    ]);
    expect(f.events().map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(f.events().map((event) => event.epoch)).size).toBe(1);
    expect(f.events()[2]).toMatchObject({
      childId: "child-one",
      taskId: "task-one",
      parentToolCallId: "script",
      args: '{"path":"file.txt"}',
    });
    expect(f.events()[3]).toMatchObject({
      result: "file contents",
      isError: false,
      truncated: true,
    });
    expect(JSON.stringify(f.entries)).not.toMatch(/private|BINARY|OMIT|not forwarded/);
    expect(f.appendEntry.mock.calls.every(([type]) => type === SUBAGENT_ACTIVITY_ENTRY)).toBe(true);
  });

  it("supports public observers without enabling persistence and unsubscribes on disposal", () => {
    const f = fixture(false);
    const listener = vi.fn();
    const unsubscribe = f.activity.subscribe(listener);
    assistant(f.activity, "one");
    unsubscribe();
    assistant(f.activity, "two");
    f.activity.subscribe(listener);
    f.activity.dispose();
    assistant(f.activity, "three");
    expect(listener).toHaveBeenCalledTimes(1);
    expect(f.appendEntry).not.toHaveBeenCalled();
  });

  it("removes throwing observers and emits one diagnostic without changing other observers", () => {
    const f = fixture();
    const broken = vi.fn(() => {
      throw new Error("observer broke");
    });
    const good = vi.fn();
    f.activity.subscribe(broken);
    f.activity.subscribe(good);
    expect(() => assistant(f.activity, "one")).not.toThrow();
    assistant(f.activity, "two");
    expect(broken).toHaveBeenCalledTimes(1);
    expect(good).toHaveBeenCalledTimes(3);
    expect(f.events().filter((event) => event.kind === "truncated")).toMatchObject([
      { scope: "session", reason: "observer_error" },
    ]);
    expect(f.diagnostic).toHaveBeenCalledTimes(1);
  });

  it("stops failing persistence without throwing or recursively retrying diagnostics", () => {
    const f = fixture();
    f.appendEntry.mockImplementation(() => {
      throw new Error("disk full");
    });
    const listener = vi.fn();
    f.activity.subscribe(listener);
    expect(() => assistant(f.activity, "one")).not.toThrow();
    assistant(f.activity, "two");
    expect(f.appendEntry).toHaveBeenCalledTimes(1);
    expect(f.diagnostic).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("isolates rejected async observers without an unhandled rejection", async () => {
    const f = fixture();
    const broken = vi.fn(async () => {
      await Promise.resolve();
      throw new Error("async observer broke");
    });
    const good = vi.fn();
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      f.activity.subscribe(broken);
      f.activity.subscribe(good);
      assistant(f.activity, "one");
      await new Promise<void>((resolve) => setImmediate(resolve));
      assistant(f.activity, "two");
      expect(broken).toHaveBeenCalledTimes(1);
      expect(good).toHaveBeenCalledTimes(3);
      expect(f.events().filter((event) => event.kind === "truncated")).toMatchObject([
        { scope: "session", reason: "observer_error" },
      ]);
      expect(f.diagnostic).toHaveBeenCalledTimes(1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });

  it("bounds serialized escaped text and arguments, retaining tool identity", () => {
    const f = fixture();
    assistant(f.activity, "\u0000".repeat(40_000));
    f.activity.sessionEvent(snapshot(), {
      type: "tool_execution_start",
      toolCallId: "same-call",
      toolName: "bash",
      args: { command: "\u0000".repeat(40_000) },
    });
    expect(f.events()).toHaveLength(2);
    for (const event of f.events()) {
      expect(entryBytes(event)).toBeLessThanOrEqual(SUBAGENT_ACTIVITY_LIMITS.event);
      expect(Buffer.byteLength(serializedEntry(event))).toBeLessThanOrEqual(
        SUBAGENT_ACTIVITY_LIMITS.event,
      );
      expect(event).toMatchObject({ truncated: true });
    }
    expect(f.events()[1]).toMatchObject({ toolCallId: "same-call", toolName: "bash" });
  });

  it("retains byte limits across process epochs and gives each resumed task its own budget", () => {
    const f = fixture();
    const text = "x".repeat(8192);
    for (let i = 0; i < 160; i++) assistant(f.activity, text);
    const taskMarker = f.events().filter((event) => event.kind === "truncated");
    expect(taskMarker).toMatchObject([{ scope: "task", reason: "byte_limit" }]);
    expect(f.events().reduce((total, event) => total + entryBytes(event), 0)).toBeLessThanOrEqual(
      SUBAGENT_ACTIVITY_LIMITS.task,
    );
    const restored = fixture(true, f.entries);
    const priorCount = restored.entries.length;
    assistant(restored.activity, "same task");
    expect(restored.entries).toHaveLength(priorCount);
    assistant(restored.activity, "resumed task", snapshot("task-two"));
    expect(restored.entries).toHaveLength(priorCount + 1);
    expect(restored.events().at(-1)?.epoch).not.toEqual(f.events()[0]?.epoch);
    for (let task = 2; task < 12; task++)
      for (let i = 0; i < 160; i++) assistant(restored.activity, text, snapshot(`task-${task}`));
    expect(
      restored.events().filter((event) => event.kind === "truncated" && event.scope === "session"),
    ).toHaveLength(1);
    expect(
      restored.events().reduce((total, event) => total + entryBytes(event), 0),
    ).toBeLessThanOrEqual(SUBAGENT_ACTIVITY_LIMITS.session);
    const exhausted = fixture(true, restored.entries);
    expect(exhausted.diagnostic).toHaveBeenCalledTimes(1);
    expect(exhausted.diagnostic.mock.calls[0]?.[0]).toMatch(
      /byte limit.*Reset the parent session/u,
    );
    const exhaustedCount = exhausted.entries.length;
    assistant(exhausted.activity, "future task", snapshot("task-future"));
    expect(exhausted.entries).toHaveLength(exhaustedCount);
    expect(
      restored
        .events()
        .reduce((total, event) => total + Buffer.byteLength(serializedEntry(event)), 0),
    ).toBeLessThanOrEqual(SUBAGENT_ACTIVITY_LIMITS.session);
  });

  it("charges the same entry overhead when restoring a partially used task budget", () => {
    const f = fixture();
    for (let index = 0; index < 450; index++) assistant(f.activity, "small completed message");
    expect(f.events().some((event) => event.kind === "truncated")).toBe(false);
    const restored = fixture(true, f.entries);
    for (let index = 0; index < 450; index++)
      assistant(restored.activity, "small completed message");
    expect(restored.events().filter((event) => event.kind === "truncated")).toMatchObject([
      { scope: "task", reason: "byte_limit" },
    ]);
    expect(
      restored.events().reduce((total, event) => total + entryBytes(event), 0),
    ).toBeLessThanOrEqual(SUBAGENT_ACTIVITY_LIMITS.task);
  });
});
