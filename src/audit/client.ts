import { randomBytes } from "node:crypto";
import { freezeJson } from "../service/json.js";
import {
  ServiceError,
  type AuditAcknowledgment,
  type AuditHandle,
  type PolicyOrigin,
  type ServiceTransport,
} from "../service/protocol.js";
import {
  validExportAuditEvent,
  EXPORT_AUDIT_EVENTS,
  type UserExportAuditDetails,
} from "./exports.js";
import { isCommandSetId, MAXIMUM_COMMAND_SETS } from "../permissions/bash/command-set-contracts.js";

export interface AuditEvent {
  event:
    | "session_started"
    | "tool_requested"
    | "tool_denied"
    | "tool_execution_intent"
    | "tool_completed"
    | "session_ended"
    | "export_intent"
    | "export_complete"
    | "export_replace_intent"
    | "export_replace_complete";
  user_export?: UserExportAuditDetails;
  pi_session_id: string;
  cwd?: string;
  invocation_id?: string;
  tool?: string;
  boundary?: "bubblewrap" | "direct" | "seatbelt" | "host";
  extension?: string;
  mcp_server?: string;
  mcp_tool?: string;
  mcp_transport?: "http" | "stdio";
  parent_invocation_id?: string;
  child_id?: string;
  child_session_id?: string;
  child_task_id?: string;
  approval_source?: "policy" | "prompt" | "session_grant";
  reason?: string;
  outcome?: "success" | "error" | "cancelled" | "timeout";
  duration_ms?: number;
  path?: string;
  repository?: string;
  command?: string;
  command_truncated?: boolean;
  /** Present on Bash decision events only while the effective policy has a class policy. */
  command_class?: "known_read_only" | "unclassified" | "configured_command";
  known_read_only_version?: number;
  command_set_ids?: readonly string[];
}

/** The audit collector stores the registry version as an unsigned 32-bit integer. */
export const MAXIMUM_KNOWN_READ_ONLY_VERSION = 0xffff_ffff;
const MAX_REQUEST_BYTES = 32_768;

export function validAuditText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= maximum
  );
}

export function auditCommand(value: string): Pick<AuditEvent, "command" | "command_truncated"> {
  let command = "";
  let size = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(JSON.stringify(character)) - 2;
    if (/[\uD800-\uDFFF]/u.test(character) || character === "\0" || size + bytes > 4096) break;
    command += character;
    size += bytes;
  }
  return { command, command_truncated: command.length < value.length };
}

export function validateAuditEvent(event: AuditEvent): void {
  if ((EXPORT_AUDIT_EVENTS as readonly string[]).includes(event.event)) {
    if (!validExportAuditEvent(event, validAuditText)) throw new Error("Invalid audit event");
    return;
  }

  const toolEvent = [
    "tool_requested",
    "tool_denied",
    "tool_execution_intent",
    "tool_completed",
  ].includes(event.event);
  const limits = {
    pi_session_id: 256,
    cwd: 4096,
    invocation_id: 256,
    tool: 128,
    extension: 128,
    mcp_server: 32,
    mcp_tool: 128,
    parent_invocation_id: 256,
    child_id: 128,
    child_session_id: 256,
    child_task_id: 128,
    path: 4096,
    repository: 8192,
  } as const;
  const choices = {
    event: [
      "session_started",
      "session_ended",
      "tool_requested",
      "tool_denied",
      "tool_execution_intent",
      "tool_completed",
    ],
    boundary: ["bubblewrap", "direct", "seatbelt", "host"],
    mcp_transport: ["http", "stdio"],
    approval_source: ["policy", "prompt", "session_grant"],
    reason: [
      "policy_denied",
      "user_denied",
      "cancelled",
      "disabled",
      "no_ui",
      "prompt_error",
      "invalid_prompt_decision",
    ],
    outcome: ["success", "error", "cancelled", "timeout"],
    command_class: ["known_read_only", "unclassified", "configured_command"],
  };
  const allowed = new Set([
    ...Object.keys(limits),
    ...Object.keys(choices),
    "command",
    "command_truncated",
    "duration_ms",
    "known_read_only_version",
    "command_set_ids",
  ]);
  const invalid = () => {
    throw new Error("Invalid audit event");
  };
  for (const key of Object.keys(event)) if (!allowed.has(key)) invalid();
  for (const [key, maximum] of Object.entries(limits)) {
    const value = event[key as keyof typeof limits];
    if (value !== undefined && !validAuditText(value, maximum)) invalid();
  }
  for (const [key, values] of Object.entries(choices)) {
    const value = event[key as keyof typeof choices];
    if (value !== undefined && !values.includes(value)) invalid();
  }
  if (!validAuditText(event.pi_session_id, 256) || !choices.event.includes(event.event)) invalid();
  if (
    (event.cwd !== undefined && !event.cwd.startsWith("/")) ||
    (event.path !== undefined && !event.path.startsWith("/"))
  )
    invalid();
  if (event.event === "session_started" && event.cwd === undefined) invalid();
  if (toolEvent && (event.tool === undefined || event.invocation_id === undefined)) invalid();
  if (
    !toolEvent &&
    Object.entries(event).some(
      ([key, value]) => value !== undefined && !["event", "pi_session_id", "cwd"].includes(key),
    )
  )
    invalid();
  if (event.repository !== undefined && event.extension === undefined) invalid();
  const child = [event.child_id, event.child_session_id, event.child_task_id];
  if (child.some((value) => value !== undefined) && child.some((value) => value === undefined))
    invalid();
  const mcp = [event.mcp_server, event.mcp_tool, event.mcp_transport];
  if (
    mcp.some((value) => value !== undefined) &&
    (mcp.some((value) => value === undefined) ||
      event.boundary !== "host" ||
      !/^[a-z][a-z0-9_]{0,31}$/.test(event.mcp_server!) ||
      /[\p{Cc}]/u.test(event.mcp_tool!) ||
      event.extension !== undefined)
  )
    invalid();
  if (
    event.parent_invocation_id !== undefined &&
    event.parent_invocation_id === event.invocation_id
  )
    invalid();
  if ((event.command === undefined) !== (event.command_truncated === undefined)) invalid();
  if (
    event.command !== undefined &&
    (event.tool !== "bash" ||
      typeof event.command !== "string" ||
      /[\uD800-\uDFFF]/u.test(event.command) ||
      event.command.includes("\0") ||
      typeof event.command_truncated !== "boolean")
  )
    invalid();
  if ((event.command_class === undefined) !== (event.known_read_only_version === undefined))
    invalid();
  if (event.command_class === "configured_command") {
    const ids = event.command_set_ids;
    if (
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > MAXIMUM_COMMAND_SETS ||
      new Set(ids).size !== ids.length ||
      !ids.every((id: unknown) => typeof id === "string" && isCommandSetId(id))
    )
      invalid();
  } else if (event.command_set_ids !== undefined) invalid();
  if (
    event.command_class !== undefined &&
    (event.tool !== "bash" ||
      (event.event !== "tool_execution_intent" && event.event !== "tool_denied") ||
      !Number.isSafeInteger(event.known_read_only_version) ||
      event.known_read_only_version! < 1 ||
      event.known_read_only_version! > MAXIMUM_KNOWN_READ_ONLY_VERSION)
  )
    invalid();
  if (
    event.duration_ms !== undefined &&
    (!Number.isSafeInteger(event.duration_ms) || event.duration_ms < 0)
  )
    invalid();
}

const bindingBrand: unique symbol = Symbol("audit binding");
export interface AuditBinding {
  readonly [bindingBrand]: true;
  readonly generation: number;
  readonly piSessionId: string;
}
export interface AuditClient {
  setSession(id: string): Promise<void>;
  endSession(id: string): Promise<void>;
  checkpoint(sessionId?: string): Promise<AuditBinding>;
  captureInvocation(id: string): Promise<AuditBinding>;
  submit(binding: AuditBinding, event: AuditEvent): Promise<void>;
  isCurrent(binding: AuditBinding): boolean;
  diagnostics(): { readonly connected: boolean; readonly failure?: string };
  close(): Promise<void>;
}
interface PendingEvent {
  readonly event: AuditEvent;
  readonly bytes: number;
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}
interface HandleState {
  readonly binding: AuditBinding;
  readonly handle: AuditHandle;
  nextSequence: number;
  valid: boolean;
  readonly queue: PendingEvent[];
  active: boolean;
}
const unavailable = () =>
  new Error("Pi Sandbox auditing is unavailable; resubmit a message to reconnect");

/** Failure belongs to a generation; only an explicit user checkpoint clears it. */
export class AuditManager implements AuditClient {
  private readonly instance = randomBytes(16).toString("hex");
  private readonly bindings = new WeakMap<AuditBinding, HandleState>();
  private generation = 0;
  private fence = 0;
  private failure: Error | undefined;
  private sessionId: string | undefined;
  private current: HandleState | undefined;
  private pendingOpen:
    { readonly fence: number; readonly promise: Promise<AuditBinding> } | undefined;
  private pendingCheckpoint:
    { readonly fence: number; readonly promise: Promise<AuditBinding> } | undefined;
  private attempted = false;
  private closed = false;
  private queuedCount = 0;
  private queuedBytes = 0;
  constructor(
    private readonly transport: ServiceTransport,
    private readonly cwd: string,
    private readonly origin: PolicyOrigin,
  ) {}
  diagnostics(): { connected: boolean; failure?: string } {
    return {
      connected: this.current?.valid === true,
      ...(this.failure ? { failure: this.failure.message } : {}),
    };
  }
  isCurrent(binding: AuditBinding): boolean {
    const state = this.bindings.get(binding);
    return !this.closed && state !== undefined && state === this.current && state.valid;
  }
  async setSession(id: string): Promise<void> {
    if (this.closed || id === this.sessionId) return;
    if (!validAuditText(id, 256) || /\p{Cc}/u.test(id))
      throw new Error("Invalid Pi audit session ID");
    const previous = this.current;
    this.fence++;
    this.current = undefined;
    this.pendingOpen = undefined;
    this.pendingCheckpoint = undefined;
    this.sessionId = id;
    this.attempted = false;
    if (previous) {
      const idle = !previous.active && previous.queue.length === 0;
      this.detach(previous);
      if (idle) void this.closeHandle(previous);
    }
    if (!this.failure) {
      try {
        await this.open();
      } catch {
        /* Session changes and startup remain usable. */
      }
    }
  }
  async endSession(id: string): Promise<void> {
    if (this.closed || this.sessionId !== id) return;
    this.fence++;
    this.sessionId = undefined;
    this.pendingOpen = undefined;
    this.pendingCheckpoint = undefined;
    const current = this.current;
    this.current = undefined;
    if (current) {
      const idle = !current.active && current.queue.length === 0;
      this.detach(current);
      if (idle) await this.closeHandle(current);
    }
  }
  checkpoint(sessionId?: string): Promise<AuditBinding> {
    if (this.closed || !this.sessionId || (sessionId !== undefined && sessionId !== this.sessionId))
      return Promise.reject(unavailable());
    if (this.pendingCheckpoint?.fence === this.fence) return this.pendingCheckpoint.promise;
    const fence = this.fence;
    const promise = this.checkpointAt(fence);
    const pending = { fence, promise };
    this.pendingCheckpoint = pending;
    void promise
      .finally(() => {
        if (this.pendingCheckpoint === pending) this.pendingCheckpoint = undefined;
      })
      .catch(() => {});
    return promise;
  }
  private async checkpointAt(fence: number): Promise<AuditBinding> {
    const current = this.current;
    if (!current?.valid) return this.open(true);
    try {
      const result = await this.transport.request("audit_check", this.address(current));
      this.match(current, result);
      if (fence !== this.fence || !this.isCurrent(current.binding)) throw unavailable();
      this.failure = undefined;
      return current.binding;
    } catch (error) {
      if (fence !== this.fence || !this.isCurrent(current.binding)) throw unavailable();
      this.fail(current);
      if (error instanceof ServiceError && error.code === "unknown_audit_session")
        return this.open(true);
      throw unavailable();
    }
  }
  async captureInvocation(id: string): Promise<AuditBinding> {
    if (this.closed || id !== this.sessionId || this.failure) throw unavailable();
    if (this.current?.valid) return this.current.binding;
    if (this.pendingOpen?.fence === this.fence) return this.pendingOpen.promise;
    if (!this.attempted) return this.open();
    throw unavailable();
  }
  private open(recovery = false): Promise<AuditBinding> {
    if (this.pendingOpen?.fence === this.fence) return this.pendingOpen.promise;
    if (
      this.closed ||
      !this.sessionId ||
      (!recovery && this.failure) ||
      this.generation >= Number.MAX_SAFE_INTEGER
    )
      return Promise.reject(unavailable());
    const fence = this.fence;
    const sessionId = this.sessionId;
    const generation = ++this.generation;
    this.attempted = true;
    const promise = (async () => {
      try {
        const result = await this.transport.request("audit_open", {
          client_instance_id: this.instance,
          audit_generation: generation,
          pi_session_id: sessionId,
          cwd: this.cwd,
          policy_origin: this.origin,
        });
        if (
          this.closed ||
          fence !== this.fence ||
          this.sessionId !== sessionId ||
          result.audit_generation !== generation ||
          result.next_sequence !== 1
        )
          throw unavailable();
        const binding: AuditBinding = Object.freeze({
          [bindingBrand]: true as const,
          generation,
          piSessionId: sessionId,
        });
        const state: HandleState = {
          binding,
          handle: result,
          nextSequence: 1,
          valid: true,
          queue: [],
          active: false,
        };
        this.bindings.set(binding, state);
        this.current = state;
        this.failure = undefined;
        return binding;
      } catch {
        if (!this.closed && fence === this.fence && this.sessionId === sessionId) {
          this.failure = unavailable();
          this.fence++;
          this.current = undefined;
        }
        throw unavailable();
      }
    })();
    const pending = { fence, promise };
    this.pendingOpen = pending;
    void promise
      .finally(() => {
        if (this.pendingOpen === pending) this.pendingOpen = undefined;
      })
      .catch(() => {});
    return promise;
  }
  submit(binding: AuditBinding, event: AuditEvent): Promise<void> {
    const state = this.bindings.get(binding);
    if (!state || !this.isCurrent(binding) || this.failure) return Promise.reject(unavailable());
    let copy: AuditEvent;
    let bytes: number;
    try {
      copy = freezeJson(structuredClone(event));
      validateAuditEvent(copy);
      if (
        copy.event === "session_started" ||
        copy.event === "session_ended" ||
        copy.pi_session_id !== binding.piSessionId
      )
        throw new Error("Invalid audit event session");
      if (copy.command !== undefined && Buffer.byteLength(JSON.stringify(copy.command)) - 2 > 4096)
        throw new Error("Audit command exceeds size limit");
      bytes = Buffer.byteLength(JSON.stringify(copy)) + 1024;
      if (bytes > MAX_REQUEST_BYTES) throw new Error("Audit request exceeds size limit");
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error("Invalid audit event"));
    }
    if (this.queuedCount >= 64 || this.queuedBytes + bytes > 2 * 1024 * 1024) {
      this.fail(state);
      return Promise.reject(unavailable());
    }
    this.queuedCount++;
    this.queuedBytes += bytes;
    return new Promise<void>((resolve, reject) => {
      const pending: PendingEvent = {
        event: copy,
        bytes,
        resolve,
        reject,
        timer: setTimeout(() => {
          if (state.queue.includes(pending)) this.fail(state);
        }, 30_000),
      };
      state.queue.push(pending);
      void this.drain(state);
    });
  }
  private async drain(state: HandleState): Promise<void> {
    if (state.active) return;
    const pending = state.queue.shift();
    if (!pending) return;
    clearTimeout(pending.timer);
    state.active = true;
    try {
      if (
        !this.isCurrent(state.binding) ||
        this.failure ||
        state.nextSequence >= Number.MAX_SAFE_INTEGER
      )
        throw unavailable();
      const sequence = state.nextSequence;
      const result = await this.transport.request("audit_event", {
        ...this.address(state),
        sequence,
        event: pending.event,
      });
      this.match(state, result);
      if (!this.isCurrent(state.binding) || result.next_sequence !== sequence + 1)
        throw unavailable();
      state.nextSequence = result.next_sequence;
      pending.resolve();
    } catch {
      this.fail(state);
      pending.reject(unavailable());
    } finally {
      this.queuedCount--;
      this.queuedBytes -= pending.bytes;
      state.active = false;
      void this.drain(state);
    }
  }
  private match(state: HandleState, result: AuditHandle): void {
    if (
      result.audit_session_id !== state.handle.audit_session_id ||
      result.service_epoch !== state.handle.service_epoch ||
      result.audit_generation !== state.binding.generation
    )
      throw unavailable();
  }
  private address(state: HandleState) {
    return {
      audit_session_id: state.handle.audit_session_id,
      service_epoch: state.handle.service_epoch,
    };
  }
  private detach(state: HandleState): void {
    state.valid = false;
    for (const pending of state.queue.splice(0)) {
      clearTimeout(pending.timer);
      this.queuedCount--;
      this.queuedBytes -= pending.bytes;
      pending.reject(unavailable());
    }
  }
  private fail(state: HandleState): void {
    this.detach(state);
    if (this.current === state) {
      this.current = undefined;
      this.failure = unavailable();
      this.fence++;
      this.pendingCheckpoint = undefined;
      this.pendingOpen = undefined;
    }
  }
  private async closeHandle(state: HandleState): Promise<void> {
    try {
      if (state.nextSequence >= Number.MAX_SAFE_INTEGER) return;
      const result: AuditAcknowledgment = await this.transport.request(
        "audit_close",
        { ...this.address(state), sequence: state.nextSequence },
        2000,
      );
      this.match(state, result);
      if (result.next_sequence !== state.nextSequence + 1) throw unavailable();
    } catch {
      /* Best-effort close never retries or blocks shutdown. */
    }
  }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.fence++;
    const current = this.current;
    this.current = undefined;
    this.pendingOpen = undefined;
    this.pendingCheckpoint = undefined;
    if (current) {
      const idle = !current.active && current.queue.length === 0;
      this.detach(current);
      if (idle) await this.closeHandle(current);
    }
  }
}
