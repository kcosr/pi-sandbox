import { AsyncLocalStorage } from "node:async_hooks";

import type { ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

import { prepareApprovalRequest, type ApprovalDecision, type JsonObject } from "../policy/index.js";
import { SandboxExecutionError } from "../sandbox/index.js";
import { ManagedToolExecutionError } from "../runtime/tool-error.js";
import { HostCommandExecutionError } from "../host/index.js";
import { normalizeSandboxPath } from "../extension/executor-operations.js";
import { auditCommand, validAuditText, type AuditClient, type AuditEvent } from "./client.js";

interface Invocation {
  readonly fields: Pick<
    AuditEvent,
    | "pi_session_id"
    | "invocation_id"
    | "tool"
    | "boundary"
    | "extension"
    | "mcp_server"
    | "mcp_tool"
    | "mcp_transport"
    | "parent_invocation_id"
  >;
  denied: boolean;
  approval?: ApprovalDecision["source"];
}

function errorOutcome(error: unknown, signal?: AbortSignal): "error" | "cancelled" | "timeout" {
  if (signal?.aborted === true) return "cancelled";
  const seen = new Set<Error>();
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error);
    if (error instanceof ManagedToolExecutionError) return error.code;
    if (error instanceof SandboxExecutionError || error instanceof HostCommandExecutionError) {
      if (error.code === "sandbox_aborted" || error.code === "host_command_aborted")
        return "cancelled";
      if (error.code === "sandbox_timeout" || error.code === "host_command_timeout")
        return "timeout";
    }
    error = error.cause;
  }
  return "error";
}

/** Fields are deliberately selected here rather than derived from arbitrary tool arguments. */
export function toolAuditMetadata(
  tool: string,
  args: Record<string, unknown>,
  cwd: string,
  home: string,
): Pick<AuditEvent, "path" | "command" | "command_truncated"> {
  if (["read", "write", "edit", "ls", "find", "grep"].includes(tool)) {
    const path = args.path ?? (["ls", "find", "grep"].includes(tool) ? "." : undefined);
    if (typeof path !== "string") return {};
    try {
      const normalized = normalizeSandboxPath(cwd, path, home);
      return validAuditText(normalized, 4096) ? { path: normalized } : {};
    } catch {
      // Execution validates invalid paths; never substitute a different target in the log.
      return {};
    }
  }
  if (tool === "bash" && typeof args.command === "string") {
    return auditCommand(args.command);
  }
  return {};
}

export class ToolAuditor {
  private readonly invocation = new AsyncLocalStorage<Invocation>();
  private failure: Error | undefined;
  private sessionId: string | undefined;
  private sessionQueue = Promise.resolve();

  public constructor(
    private readonly client: AuditClient,
    private readonly cwd: string,
    private readonly home: string,
  ) {}

  private async submit(event: AuditEvent): Promise<void> {
    if (this.failure !== undefined) throw this.failure;
    try {
      await this.client.submit(event);
    } catch {
      this.failure = new Error(
        "Pi Sandbox tool logging is unavailable; no further logged tools can execute",
      );
      throw this.failure;
    }
  }

  public async start(ctx: ExtensionContext): Promise<void> {
    const id = ctx.sessionManager.getSessionId();
    const transition = this.sessionQueue.then(async () => {
      if (this.sessionId === id) return;
      await this.endSession();
      await this.submit({ event: "session_started", pi_session_id: id, cwd: this.cwd });
      this.sessionId = id;
    });
    this.sessionQueue = transition.catch(() => undefined);
    await transition;
  }

  public async end(): Promise<void> {
    const transition = this.sessionQueue.then(() => this.endSession());
    this.sessionQueue = transition.catch(() => undefined);
    await transition;
  }

  private async endSession(): Promise<void> {
    if (this.sessionId === undefined) return;
    const id = this.sessionId;
    this.sessionId = undefined;
    await this.submit({ event: "session_ended", pi_session_id: id });
  }

  public async decision(decision: ApprovalDecision, tool?: string): Promise<void> {
    const invocation = this.invocation.getStore();
    if (invocation === undefined || (tool !== undefined && invocation.fields.tool !== tool)) return;
    invocation.approval = decision.source;
    if (!decision.allowed) {
      invocation.denied = true;
      await this.submit({
        ...invocation.fields,
        event: "tool_denied",
        approval_source: decision.source,
        reason: decision.reason,
      });
    } else {
      await this.submit({
        ...invocation.fields,
        event: "tool_execution_intent",
        approval_source: decision.source,
      });
    }
  }

  public wrap(
    definition: ToolDefinition,
    boundary: "bubblewrap" | "direct" | "host",
    extension?: string,
    target?: (
      args: JsonObject,
      cwd: string,
    ) => { readonly path?: string; readonly repository?: string },
    metadata?: Pick<AuditEvent, "mcp_server" | "mcp_tool" | "mcp_transport">,
    feature = false,
  ): ToolDefinition {
    return {
      ...definition,
      execute: async (id, params, signal, onUpdate, ctx) => {
        const args = prepareApprovalRequest({
          subject: definition.name,
          display: definition.name,
          arguments: params as JsonObject,
        }).arguments;
        let targetFields: { readonly path?: string; readonly repository?: string } = {};
        if (target !== undefined) {
          try {
            const selected = target(args, this.cwd);
            targetFields = {
              ...(validAuditText(selected.path, 4096) && selected.path.startsWith("/")
                ? { path: selected.path }
                : {}),
              ...(validAuditText(selected.repository, 8192)
                ? { repository: selected.repository }
                : {}),
            };
          } catch {
            /* Invalid target arguments are rejected by the tool itself. */
          }
        }
        await this.start(ctx);
        const fields = {
          pi_session_id: ctx.sessionManager.getSessionId(),
          invocation_id: id,
          tool: definition.name,
          boundary,
          ...metadata,
          ...(this.invocation.getStore() === undefined
            ? {}
            : {
                parent_invocation_id: this.invocation.getStore()!.fields.invocation_id!,
              }),
          ...(extension === undefined ? {} : { extension }),
          ...toolAuditMetadata(definition.name, args, this.cwd, this.home),
          ...targetFields,
        };
        await this.submit({ ...fields, event: "tool_requested" });
        const invocation: Invocation = { fields, denied: false };
        const started = performance.now();
        return this.invocation.run(invocation, async () => {
          let result;
          try {
            if (feature)
              await this.decision(
                { allowed: true, source: "policy", reason: "policy_allowed" },
                definition.name,
              );
            result = await definition.execute(id, args, signal, onUpdate, ctx);
          } catch (error) {
            if (!invocation.denied && this.failure === undefined) {
              const outcome = errorOutcome(error, signal);
              await this.submit({
                ...fields,
                event: "tool_completed",
                outcome,
                duration_ms: Math.round(performance.now() - started),
                ...(invocation.approval === undefined
                  ? {}
                  : { approval_source: invocation.approval }),
              });
            }
            throw error;
          }
          // Reporting failure after an effect never retries the operation or emits a false failure outcome.
          let outcome: AuditEvent["outcome"] =
            "isError" in result && result.isError === true ? "error" : "success";
          // Only the trusted code-mode adapter provides typed VM failure metadata.
          // MCP/ordinary tool results remain untrusted, even if they use the same keys.
          if (
            feature &&
            outcome === "error" &&
            typeof result.details === "object" &&
            result.details !== null
          ) {
            const kind = (result.details as Record<string, unknown>).failureKind;
            if (kind === "timeout") outcome = "timeout";
            else if (kind === "aborted") outcome = "cancelled";
          }
          await this.submit({
            ...fields,
            event: "tool_completed",
            outcome,
            duration_ms: Math.round(performance.now() - started),
            ...(invocation.approval === undefined ? {} : { approval_source: invocation.approval }),
          });
          return result;
        });
      },
    };
  }
}
