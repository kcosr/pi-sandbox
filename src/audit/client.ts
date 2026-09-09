import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute, normalize } from "node:path";

export interface AuditEvent {
  event:
    | "session_started"
    | "tool_requested"
    | "tool_denied"
    | "tool_execution_intent"
    | "tool_completed"
    | "session_ended";
  pi_session_id: string;
  cwd?: string;
  invocation_id?: string;
  tool?: string;
  boundary?: "bubblewrap" | "direct" | "host";
  extension?: string;
  approval_source?: "policy" | "prompt" | "session_grant";
  reason?: string;
  outcome?: "success" | "error" | "cancelled" | "timeout";
  duration_ms?: number;
  path?: string;
  repository?: string;
  command?: string;
  command_truncated?: boolean;
}

export interface AuditClient {
  submit(event: AuditEvent): Promise<void>;
  close(): Promise<void>;
}

const DEADLINE_MS = 10_000;
const MAX_REQUEST_BYTES = 32_768;
const MAX_RESPONSE_BYTES = 4_096;

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

function validateEvent(event: AuditEvent): void {
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
    boundary: ["bubblewrap", "direct", "host"],
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
  };
  const allowed = new Set([
    ...Object.keys(limits),
    ...Object.keys(choices),
    "command",
    "command_truncated",
    "duration_ms",
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
  if (
    event.duration_ms !== undefined &&
    (!Number.isSafeInteger(event.duration_ms) || event.duration_ms < 0)
  )
    invalid();
}

async function verifySocketPath(path: string): Promise<void> {
  if (!isAbsolute(path) || normalize(path) !== path) {
    throw new Error("Audit socket path must be absolute and normalized");
  }
  const socket = await lstat(path);
  if (!socket.isSocket() || socket.isSymbolicLink() || socket.uid !== 0) {
    throw new Error("Audit socket must be a root-owned Unix socket");
  }
  let ancestor = dirname(path);
  for (;;) {
    const info = await lstat(ancestor);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== 0 ||
      (info.mode & 0o022) !== 0
    ) {
      throw new Error("Audit socket ancestors must be root-owned protected directories");
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
}

/** A failed connection is never reused or retried: execution may already have occurred. */
export async function connectAuditClient(path: string): Promise<AuditClient> {
  await verifySocketPath(path);
  const socket = createConnection({ path });
  let failure: Error | undefined;
  let closed = false;
  let auditSessionId: string | undefined;
  let buffer = Buffer.alloc(0);
  let pending: { resolve(): void; reject(error: Error): void } | undefined;
  let queue = Promise.resolve();
  const poison = (error: Error) => {
    failure ??= error;
    pending?.reject(failure);
    pending = undefined;
    socket.destroy();
  };
  socket.on("error", () => poison(new Error("Audit collector connection failed")));
  socket.on("close", () => {
    if (!closed) poison(new Error("Audit collector connection closed"));
  });
  socket.on("data", (chunk: Buffer) => {
    if (!pending) {
      poison(new Error("Unexpected audit collector response"));
      return;
    }
    buffer = Buffer.concat([buffer, chunk]);
    if (buffer.length > MAX_RESPONSE_BYTES) {
      poison(new Error("Audit collector response exceeds size limit"));
      return;
    }
    const newline = buffer.indexOf(10);
    if (newline === -1) return;
    if (newline !== buffer.length - 1) {
      poison(new Error("Unexpected trailing audit collector response"));
      return;
    }
    try {
      const response: unknown = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
      if (typeof response !== "object" || response === null || Array.isArray(response)) {
        throw new Error("Invalid audit collector response");
      }
      const record = response as Record<string, unknown>;
      const keys = Object.keys(record).sort().join(",");
      if (record.version !== 1) throw new Error("Invalid audit collector version");
      if (record.ok === false && keys === "code,ok,version") {
        if (
          !["protocol_error", "syslog_unavailable", "audit_disabled"].includes(String(record.code))
        ) {
          throw new Error("Invalid audit collector error");
        }
        throw new Error(`Audit collector rejected event: ${String(record.code)}`);
      }
      if (
        record.ok !== true ||
        keys !== "audit_session_id,ok,version" ||
        typeof record.audit_session_id !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/.test(record.audit_session_id)
      )
        throw new Error("Invalid audit collector acknowledgment");
      if (auditSessionId !== undefined && auditSessionId !== record.audit_session_id) {
        throw new Error("Audit collector session changed");
      }
      auditSessionId = record.audit_session_id;
      buffer = Buffer.alloc(0);
      const completion = pending;
      pending = undefined;
      completion.resolve();
    } catch (error) {
      poison(error instanceof Error ? error : new Error("Invalid audit collector response"));
    }
  });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      poison(new Error("Audit collector connection timed out"));
    }, DEADLINE_MS);
    pending = {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    };
    socket.once("connect", () => {
      const completion = pending;
      pending = undefined;
      completion?.resolve();
    });
  });
  return {
    submit(event) {
      // Snapshot before queueing, so caller mutation cannot change the submitted event.
      let request: string;
      try {
        if (
          event.command !== undefined &&
          Buffer.byteLength(JSON.stringify(event.command)) - 2 > 4_096
        ) {
          throw new Error("Audit command exceeds size limit");
        }
        request = `${JSON.stringify({ version: 1, event })}\n`;
        if (Buffer.byteLength(request) > MAX_REQUEST_BYTES) {
          throw new Error("Audit request exceeds size limit");
        }
        validateEvent(event);
      } catch (error) {
        // Nothing was sent: malformed caller input must not destroy a healthy connection.
        return Promise.reject(error instanceof Error ? error : new Error("Invalid audit event"));
      }
      const result = queue.then(async () => {
        if (failure) throw failure;
        if (closed) throw new Error("Audit client is closed");
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => poison(new Error("Audit collector acknowledgment timed out")),
            DEADLINE_MS,
          );
          pending = {
            resolve: () => {
              clearTimeout(timer);
              resolve();
            },
            reject: (error) => {
              clearTimeout(timer);
              reject(error);
            },
          };
          socket.write(request, (error) => {
            if (error) poison(new Error("Audit collector submission failed"));
          });
        });
      });
      queue = result.catch(() => {});
      return result;
    },
    async close() {
      closed = true;
      if (pending) poison(new Error("Audit client closed during submission"));
      socket.destroy();
      await queue;
    },
  };
}
