import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { boundedText } from "./bounds.js";
import type { SubagentSnapshot, SubagentStatus } from "./contracts.js";

export const SUBAGENT_ACTIVITY_ENTRY = "pi-subagents:activity";
/** UTF-8 bytes per entry, task and session, including the reserved Pi/RPC envelope. */
export const SUBAGENT_ACTIVITY_LIMITS = Object.freeze({
  event: 16 * 1024,
  task: 1024 * 1024,
  session: 8 * 1024 * 1024,
});
const ENTRY_OVERHEAD = 1024;
const MARKER_RESERVE = 2048 + ENTRY_OVERHEAD;
const CONTENT_BYTES = 8192;

type ActivityIdentity = Readonly<{
  version: 1;
  parentSessionId: string;
  epoch: string;
  sequence: number;
  childId: string;
  taskId: string;
  label: string;
  timestamp: number;
}>;
export type SubagentActivityPayload =
  | Readonly<{ kind: "lifecycle"; status: SubagentStatus; activity: string }>
  | Readonly<{ kind: "assistant"; text: string; truncated: boolean }>
  | Readonly<{
      kind: "tool_start";
      toolCallId: string;
      toolName: string;
      parentToolCallId?: string;
      args: string;
      truncated: boolean;
    }>
  | Readonly<{
      kind: "tool_end";
      toolCallId: string;
      toolName: string;
      parentToolCallId?: string;
      result: string;
      isError: boolean;
      truncated: boolean;
    }>
  | Readonly<{
      kind: "truncated";
      scope: "task" | "session";
      reason: "byte_limit" | "observer_error";
    }>;

/** Namespaced observations; never reinterpret these as native parent Pi events. */
export type SubagentActivityEvent = ActivityIdentity & SubagentActivityPayload;

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function size(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value)) + ENTRY_OVERHEAD;
}
function taskKey(value: { childId: string; taskId: string }): string {
  return `${value.childId}\0${value.taskId}`;
}
function lifecycleSignature(snapshot: SubagentSnapshot): string {
  return `${snapshot.taskId}\0${snapshot.status}`;
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && Buffer.byteLength(value) <= 512;
}
function textContent(content: unknown): { text: string; truncated: boolean } {
  let text = "";
  let truncated = false;
  if (!Array.isArray(content)) return { text, truncated };
  for (const [index, block] of content.entries()) {
    if (index >= 128) {
      truncated = true;
      break;
    }
    if (!object(block)) continue;
    if (block.type !== "text" || typeof block.text !== "string") {
      // Reasoning is private, and tool calls have separate execution events.
      if (block.type !== "thinking" && block.type !== "toolCall") truncated = true;
      continue;
    }
    const next = text + boundedText(block.text, CONTENT_BYTES);
    truncated ||=
      Buffer.byteLength(block.text) > CONTENT_BYTES || Buffer.byteLength(next) > CONTENT_BYTES;
    text = boundedText(next, CONTENT_BYTES);
  }
  return { text, truncated };
}

/** A bounded display representation, not a second executable copy of tool arguments. */
function argumentsText(value: unknown): { text: string; truncated: boolean } {
  let remaining = 512;
  let truncated = false;
  const seen = new Set<object>();
  const visit = (input: unknown, depth: number): unknown => {
    if (--remaining < 0 || depth > 8) {
      truncated = true;
      return "[omitted]";
    }
    if (typeof input === "string") {
      truncated ||= Buffer.byteLength(input) > CONTENT_BYTES;
      return boundedText(input, CONTENT_BYTES);
    }
    if (input === null || typeof input === "number" || typeof input === "boolean") return input;
    if (typeof input !== "object") {
      truncated = true;
      return "[unsupported value]";
    }
    if (seen.has(input)) {
      truncated = true;
      return "[circular]";
    }
    seen.add(input);
    if (Array.isArray(input)) {
      truncated ||= input.length > 128;
      return input.slice(0, 128).map((item) => visit(item, depth + 1));
    }
    const entries = Object.entries(input);
    truncated ||= entries.length > 128;
    return Object.fromEntries(
      entries.slice(0, 128).map(([key, item]) => [boundedText(key, 256), visit(item, depth + 1)]),
    );
  };
  try {
    const text = JSON.stringify(visit(value, 0));
    return {
      text: boundedText(text, CONTENT_BYTES),
      truncated: truncated || Buffer.byteLength(text) > CONTENT_BYTES,
    };
  } catch {
    return { text: "[arguments unavailable]", truncated: true };
  }
}

/** Per-controller observers and optional persistent forwarding. No queues or background work. */
export class SubagentActivity {
  private readonly epoch = randomUUID();
  private sequence = 0;
  private readonly listeners = new Set<
    (event: SubagentActivityEvent) => void | PromiseLike<void>
  >();
  private readonly lifecycle = new Map<string, string>();
  private readonly taskBytes = new Map<string, number>();
  private readonly truncatedTasks = new Set<string>();
  private sessionBytes = 0;
  private sessionTruncated = false;
  private reportedObserverError = false;
  private disposed = false;

  constructor(
    private readonly pi: Pick<ExtensionAPI, "appendEntry">,
    private readonly parentSessionId: string,
    private forwarding: boolean,
    entries: readonly unknown[],
    private readonly diagnostic: (message: string) => void = () => undefined,
  ) {
    if (!forwarding) return;
    for (const entry of entries) {
      if (!object(entry) || entry.type !== "custom" || entry.customType !== SUBAGENT_ACTIVITY_ENTRY)
        continue;
      const data = entry.data;
      if (
        !object(data) ||
        data.version !== 1 ||
        data.parentSessionId !== parentSessionId ||
        typeof data.childId !== "string" ||
        typeof data.taskId !== "string"
      )
        continue;
      const bytes = size(data);
      const key = taskKey({ childId: data.childId, taskId: data.taskId });
      this.sessionBytes += bytes;
      this.taskBytes.set(key, (this.taskBytes.get(key) ?? 0) + bytes);
      if (data.kind === "truncated" && data.reason === "byte_limit") {
        if (data.scope === "session") this.sessionTruncated = true;
        if (data.scope === "task") this.truncatedTasks.add(key);
      }
    }
    this.sessionTruncated ||= this.sessionBytes >= SUBAGENT_ACTIVITY_LIMITS.session;
    if (this.sessionTruncated) {
      // A new RPC client does not receive old entry_appended events. Report the
      // restored limit without adding another entry to the exhausted journal.
      try {
        this.diagnostic(
          "Subagent activity forwarding reached this parent session's byte limit. Reset the parent session for a fresh activity budget; child execution can continue.",
        );
      } catch {
        /* Diagnostics cannot change task execution. */
      }
    }
  }

  subscribe(listener: (event: SubagentActivityEvent) => void | PromiseLike<void>): () => void {
    if (this.disposed) return () => undefined;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
    this.lifecycle.clear();
  }
  private get observing(): boolean {
    return !this.disposed && (this.forwarding || this.listeners.size > 0);
  }

  seedSnapshots(snapshots: readonly SubagentSnapshot[]): void {
    for (const snapshot of snapshots) this.lifecycle.set(snapshot.id, lifecycleSignature(snapshot));
  }

  snapshots(snapshots: readonly SubagentSnapshot[]): void {
    if (!this.observing) return;
    for (const snapshot of snapshots) {
      const key = snapshot.id;
      const signature = lifecycleSignature(snapshot);
      if (this.lifecycle.get(key) === signature) continue;
      this.lifecycle.set(key, signature);
      this.emit(snapshot, {
        kind: "lifecycle",
        status: snapshot.status,
        activity: boundedText(snapshot.activity, 256),
      });
    }
  }

  sessionEvent(snapshot: SubagentSnapshot, value: unknown): void {
    if (!this.observing || !object(value)) return;
    if (
      value.type === "message_end" &&
      object(value.message) &&
      value.message.role === "assistant"
    ) {
      const content = textContent(value.message.content);
      if (content.text || content.truncated) this.emit(snapshot, { kind: "assistant", ...content });
    }
    if (value.type !== "tool_execution_start" && value.type !== "tool_execution_end") return;
    if (
      !identifier(value.toolCallId) ||
      !identifier(value.toolName) ||
      (value.parentToolCallId !== undefined && !identifier(value.parentToolCallId))
    )
      return;
    const identity = {
      toolCallId: value.toolCallId,
      toolName: value.toolName,
      ...(value.parentToolCallId === undefined ? {} : { parentToolCallId: value.parentToolCallId }),
    };
    if (value.type === "tool_execution_start") {
      const content = argumentsText(value.args);
      this.emit(snapshot, {
        kind: "tool_start",
        ...identity,
        args: content.text,
        truncated: content.truncated,
      });
    } else {
      const content = textContent(object(value.result) ? value.result.content : undefined);
      this.emit(snapshot, {
        kind: "tool_end",
        ...identity,
        result: content.text,
        isError: value.isError === true,
        truncated: content.truncated,
      });
    }
  }

  private emit(snapshot: SubagentSnapshot, payload: SubagentActivityPayload): void {
    const event = this.bounded({
      version: 1,
      parentSessionId: this.parentSessionId,
      epoch: this.epoch,
      sequence: ++this.sequence,
      childId: snapshot.id,
      taskId: snapshot.taskId,
      label: boundedText(
        snapshot.task
          // eslint-disable-next-line no-control-regex -- labels omit terminal/control bytes
          .replace(/[\u0000-\u001f\u007f]/gu, " ")
          .replace(/\s+/gu, " ")
          .trim(),
        256,
      ),
      timestamp: Date.now(),
      ...payload,
    });
    const observerFailed = this.notify(event);
    this.forward(event);
    if (observerFailed) this.observerError(event);
  }
  private bounded(event: SubagentActivityEvent): SubagentActivityEvent {
    // Escaping controls in JSON can multiply UTF-8 bytes, so bound the serialized envelope too.
    if (size(event) <= SUBAGENT_ACTIVITY_LIMITS.event) return Object.freeze(event);
    if (event.kind === "assistant" || event.kind === "tool_start" || event.kind === "tool_end") {
      const field =
        event.kind === "assistant" ? "text" : event.kind === "tool_start" ? "args" : "result";
      const output = { ...event, truncated: true } as unknown as Record<string, unknown>;
      while (size(output) > SUBAGENT_ACTIVITY_LIMITS.event) {
        const text = output[field] as string;
        output[field] = boundedText(text, Math.floor(Buffer.byteLength(text) / 2));
      }
      return Object.freeze(output) as SubagentActivityEvent;
    }
    return Object.freeze(event);
  }
  private notify(event: SubagentActivityEvent): boolean {
    let failed = false;
    for (const listener of this.listeners) {
      try {
        const result: unknown = listener(event);
        if (
          result &&
          (typeof result === "object" || typeof result === "function") &&
          typeof (result as PromiseLike<unknown>).then === "function"
        ) {
          void Promise.resolve(result).catch(() => {
            this.listeners.delete(listener);
            if (!this.disposed) this.observerError(event);
          });
        }
      } catch {
        this.listeners.delete(listener);
        failed = true;
      }
    }
    return failed;
  }
  private marker(
    event: SubagentActivityEvent,
    scope: "task" | "session",
    reason: "byte_limit" | "observer_error",
  ): SubagentActivityEvent {
    return Object.freeze({
      version: 1,
      parentSessionId: this.parentSessionId,
      epoch: this.epoch,
      sequence: ++this.sequence,
      childId: event.childId,
      taskId: event.taskId,
      label: event.label,
      timestamp: Date.now(),
      kind: "truncated",
      scope,
      reason,
    });
  }
  private observerError(event: SubagentActivityEvent): void {
    if (this.reportedObserverError) return;
    this.reportedObserverError = true;
    try {
      this.diagnostic(
        "A subagent activity observer failed and was disabled. Child execution continues.",
      );
    } catch {
      /* Diagnostics cannot change task execution. */
    }
    const marker = this.marker(event, "session", "observer_error");
    this.notify(marker); // A throwing observer is already removed; never recurse.
    this.forward(marker);
  }
  private append(event: SubagentActivityEvent): boolean {
    try {
      this.pi.appendEntry(SUBAGENT_ACTIVITY_ENTRY, event);
    } catch {
      this.forwarding = false;
      this.observerError(event);
      return false;
    }
    const bytes = size(event);
    const key = taskKey(event);
    this.sessionBytes += bytes;
    this.taskBytes.set(key, (this.taskBytes.get(key) ?? 0) + bytes);
    return true;
  }
  private forward(event: SubagentActivityEvent): void {
    if (!this.forwarding || this.sessionTruncated) return;
    const key = taskKey(event);
    if (this.truncatedTasks.has(key)) return;
    const bytes = size(event);
    if (this.sessionBytes + bytes + MARKER_RESERVE > SUBAGENT_ACTIVITY_LIMITS.session) {
      this.sessionTruncated = true;
      const marker = this.marker(event, "session", "byte_limit");
      if (this.sessionBytes + size(marker) <= SUBAGENT_ACTIVITY_LIMITS.session) this.append(marker);
      if (this.notify(marker)) this.observerError(marker);
      return;
    }
    if ((this.taskBytes.get(key) ?? 0) + bytes + MARKER_RESERVE > SUBAGENT_ACTIVITY_LIMITS.task) {
      this.truncatedTasks.add(key);
      const marker = this.marker(event, "task", "byte_limit");
      if ((this.taskBytes.get(key) ?? 0) + size(marker) <= SUBAGENT_ACTIVITY_LIMITS.task)
        this.append(marker);
      if (this.notify(marker)) this.observerError(marker);
      return;
    }
    this.append(event);
  }
}
