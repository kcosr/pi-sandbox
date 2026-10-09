import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import {
  createMcpExtension,
  type ExtensionFactory,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { TSchema } from "@earendil-works/pi-ai";
import { Compile } from "typebox/compile";
import { StdioTransport, StreamableHttpTransport, type McpTransport } from "@earendil-works/pi-mcp";
import type { ToolPolicy } from "../domain/index.js";
import {
  prepareApprovalRequest,
  type JsonObject,
  type PolicyEngine,
  type ResolvedSubjectPolicy,
} from "../policy/index.js";
import type { ToolAuditor } from "../audit/tools.js";
import { approvalPreview, approvalUi } from "../extension/approval.js";
import { ManagedToolExecutionError } from "../runtime/tool-error.js";
import type { ResolvedMcpServer } from "./resolve.js";
import { mcpSubject, resolveMcpPolicy } from "./policy.js";
import type { ManagedMcpPreferences, McpPreferencePatch, McpPresentation } from "./preferences.js";

const MESSAGE_LIMIT = 16 * 1024 * 1024;
interface ServerEntry {
  name: string;
  config: Record<string, unknown>;
  source: string;
  scope: "global";
}
export interface McpConnection {
  readonly state: string;
  getClient(): Promise<unknown>;
  close(): Promise<void>;
}
export interface McpCatalogItem {
  readonly tool: {
    readonly name: string;
    readonly inputSchema: Record<string, unknown>;
    readonly [key: string]: unknown;
  };
  readonly definition: ToolDefinition;
}
export interface ManagedMcpOptions {
  readonly loadConfig: () => {
    servers: ServerEntry[];
    autoEnableCodemode: boolean;
    errors: string[];
  };
  readonly createTransport: (entry: { name: string }) => McpTransport;
  readonly toolsOnly: true;
  readonly authentication: false;
  readonly management: {
    readonly exposures: readonly McpPresentation[];
    readonly persistenceLabel: string;
    readonly updateConfig: (entry: { name: string }, patch: McpPreferencePatch) => Promise<void>;
  };
  readonly serverLogging: false;
  readonly allowRegisteredServers: false;
  readonly resultMode: "inline";
  readonly startupWaitMs: number;
  readonly adaptTools: (
    entry: { name: string },
    catalog: readonly McpCatalogItem[],
    connection: McpConnection,
  ) => readonly ToolDefinition[];
  readonly onServerState: (entry: { name: string }, connection: McpConnection) => void;
}
export type ManagedMcpFactory = (options: ManagedMcpOptions) => ExtensionFactory;
interface Admission {
  readonly server: string;
  readonly rawName: string;
  readonly subject: string;
  readonly revision: string;
  readonly hash: string;
  readonly policy: ToolPolicy;
  readonly rule: string;
  readonly definition: ToolDefinition;
  readonly connection: McpConnection;
  live: boolean;
}
interface InvocationGuard {
  readonly current: () => boolean;
  readonly signal: AbortSignal;
}
interface ServerState {
  readonly resolved: ResolvedMcpServer;
  status: string;
  enabled: boolean;
  exposure: McpPresentation;
  generation: number;
  active: number;
  connection?: McpConnection;
  transport?: McpTransport;
}
function validText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value) <= maximum &&
    !/[\p{Cc}\uD800-\uDFFF]/u.test(value)
  );
}
function freezeJson<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freezeJson(child);
    Object.freeze(value);
  }
  return value;
}
function checkedSchema(schema: Record<string, unknown>): TSchema {
  let nodes = 0;
  function visit(value: unknown, depth: number): void {
    if (++nodes > 100000 || depth > 64) throw new Error("MCP schema exceeds limits");
    if (value !== null && typeof value === "object")
      for (const child of Object.values(value)) visit(child, depth + 1);
  }
  visit(schema, 0);
  if (schema.type !== undefined && schema.type !== "object")
    throw new Error("MCP input schema must be an object");
  return freezeJson(structuredClone({ ...schema, type: "object" }));
}

/** One logical session's admitted dynamic catalog. All authority comes from typed entries. */
export class ManagedMcpRuntime {
  private readonly servers = new Map<string, ServerState>();
  private readonly admissions = new Map<string, Admission>();
  private readonly owners = new Map<string, string>();
  private readonly guard = new AsyncLocalStorage<InvocationGuard>();
  private readonly controller = new AbortController();
  private readonly pending = new Set<Promise<unknown>>();
  private active = 0;
  private sequence = 0;
  private stopped = false;

  public constructor(
    private readonly options: {
      readonly cwd: string;
      readonly servers: readonly ResolvedMcpServer[];
      readonly selected: (name: string) => boolean;
      readonly autoEnableCodemode?: boolean;
      readonly preferences?: ManagedMcpPreferences;
      readonly getPolicy: () => PolicyEngine | undefined;
      readonly getAuditor: () => ToolAuditor | undefined;
      readonly transportFactory?: (server: ResolvedMcpServer) => McpTransport;
    },
  ) {
    for (const resolved of options.servers) {
      const preference = options.preferences?.server(resolved.policy.id);
      this.servers.set(resolved.policy.id, {
        resolved,
        status: resolved.status,
        enabled: preference?.enabled !== false,
        exposure:
          preference?.exposure === "codemode" && !options.autoEnableCodemode
            ? resolved.policy.exposure
            : (preference?.exposure ?? resolved.policy.exposure),
        generation: 0,
        active: 0,
      });
    }
  }

  public resolveSubject = (subject: string): ResolvedSubjectPolicy | undefined => {
    const admission = this.admissions.get(subject);
    return admission !== undefined && this.current(admission)
      ? { policy: admission.policy, revision: admission.revision }
      : undefined;
  };

  public extension(
    factory: ManagedMcpFactory = createMcpExtension as unknown as ManagedMcpFactory,
  ): ExtensionFactory {
    return factory({
      toolsOnly: true,
      authentication: false,
      management: {
        exposures: this.options.autoEnableCodemode
          ? ["direct", "codemode", "hidden"]
          : ["direct", "hidden"],
        persistenceLabel: "saved for this user",
        updateConfig: (entry, patch) => this.updatePresentation(entry.name, patch),
      },
      serverLogging: false,
      allowRegisteredServers: false,
      resultMode: "inline",
      startupWaitMs: 10000,
      loadConfig: () => ({
        servers: [...this.servers.values()]
          .filter((server) => server.resolved.status === "ready")
          .map(({ resolved, enabled, exposure }) => {
            const policy = resolved.policy;
            return {
              name: policy.id,
              source: "managed-policy",
              scope: "global" as const,
              config: {
                enabled,
                exposure,
                timeout: policy.timeoutMs / 1000,
                ...(policy.transport === "http"
                  ? { url: resolved.url, headers: resolved.headers }
                  : { command: policy.command, args: [...policy.args], env: resolved.environment }),
              },
            };
          }),
        autoEnableCodemode:
          this.options.autoEnableCodemode === true &&
          this.options.preferences?.autoEnableCodemode !== false,
        errors: [],
      }),
      createTransport: (entry) => this.createTransport(entry.name),
      adaptTools: (entry, catalog, connection) => this.adaptTools(entry.name, catalog, connection),
      onServerState: (entry, connection) => this.serverChanged(entry.name, connection),
    });
  }

  private async updatePresentation(id: string, patch: McpPreferencePatch): Promise<void> {
    const state = this.servers.get(id);
    if (
      this.stopped ||
      state?.resolved.status !== "ready" ||
      Object.keys(patch).some((key) => key !== "enabled" && key !== "exposure") ||
      (patch.enabled !== undefined && typeof patch.enabled !== "boolean") ||
      (patch.exposure !== undefined &&
        !["direct", "hidden", ...(this.options.autoEnableCodemode ? ["codemode"] : [])].includes(
          patch.exposure,
        ))
    )
      throw new Error("MCP presentation change unavailable");
    await this.options.preferences?.update(id, patch);
    if (this.stopped) throw new Error("MCP session ended");
    this.invalidate(id);
    if (patch.enabled !== undefined) state.enabled = patch.enabled;
    if (patch.exposure !== undefined) state.exposure = patch.exposure;
  }

  private invalidate(server: string): void {
    const state = this.servers.get(server);
    if (state !== undefined) state.generation++;
    for (const admission of this.admissions.values())
      if (admission.server === server) {
        admission.live = false;
        this.options.getPolicy()?.invalidateSubject(admission.subject);
      }
  }

  public serverChanged(server: string, connection: McpConnection): void {
    const state = this.servers.get(server);
    if (state === undefined || this.stopped) return;
    if (state.connection !== undefined && state.connection !== connection) this.invalidate(server);
    state.connection = connection;
    state.status = ["connecting", "connected", "disconnected", "failed", "closed"].includes(
      connection.state,
    )
      ? connection.state
      : "unavailable";
    if (connection.state !== "connected") this.invalidate(server);
  }

  public adaptTools(
    server: string,
    catalog: readonly McpCatalogItem[],
    connection: McpConnection,
  ): readonly ToolDefinition[] {
    if (this.stopped && catalog.length === 0) return [];
    const state = this.servers.get(server);
    if (state === undefined || state.resolved.status !== "ready" || this.stopped)
      throw new Error("MCP server unavailable");
    if (
      catalog.length > 1024 ||
      Buffer.byteLength(JSON.stringify(catalog.map((item) => item.tool))) > 8 * 1024 * 1024
    ) {
      this.invalidate(server);
      state.status = "invalid-catalog";
      throw new Error("MCP catalog exceeds limits");
    }
    const next = new Map<string, Admission>();
    const names = new Set<string>();
    try {
      for (const item of catalog) {
        const raw = item.tool.name;
        const name = item.definition.name;
        if (
          !validText(raw, 128) ||
          !/^mcp__[A-Za-z0-9_]+$/.test(name) ||
          name.length > 64 ||
          names.has(name)
        )
          throw new Error("Invalid MCP tool identity");
        names.add(name);
        const subject = mcpSubject(server, raw);
        if (next.has(subject) || (this.owners.has(name) && this.owners.get(name) !== subject))
          throw new Error("Ambiguous MCP tool identity");
        if (
          item.tool.inputSchema === null ||
          typeof item.tool.inputSchema !== "object" ||
          Array.isArray(item.tool.inputSchema)
        )
          throw new Error("Invalid MCP schema");
        const parameters = checkedSchema(item.tool.inputSchema);
        const validator = Compile(parameters);
        const { policy, rule } = resolveMcpPolicy(state.resolved.policy, raw);
        const hash = createHash("sha256")
          .update(JSON.stringify([state.generation, item.tool, name]))
          .digest("hex");
        const old = this.admissions.get(subject);
        const revision = old?.live && old.hash === hash ? old.revision : String(++this.sequence);
        const base = { ...item.definition, parameters };
        const admission: Admission = {
          server,
          rawName: raw,
          subject,
          revision,
          hash,
          policy,
          rule,
          definition: base,
          connection,
          live: true,
        };
        const wrapped: ToolDefinition = {
          ...base,
          exposure:
            policy.mode === "disabled" ||
            !state.enabled ||
            state.exposure === "hidden" ||
            !this.options.selected(name)
              ? "hidden"
              : state.exposure === "codemode"
                ? "deferred"
                : "direct",
          execute: (id, params, signal, update, ctx) => {
            const work = this.invoke(
              admission,
              validator.Check.bind(validator),
              id,
              params,
              signal,
              update,
              ctx,
            );
            this.pending.add(work);
            void work.finally(() => this.pending.delete(work)).catch(() => undefined);
            return work;
          },
        };
        const auditor = this.options.getAuditor();
        const definition =
          policy.audit && auditor !== undefined
            ? auditor.wrap(wrapped, "host", undefined, undefined, {
                mcp_server: server,
                mcp_tool: raw,
                mcp_transport: state.resolved.policy.transport,
              })
            : wrapped;
        next.set(subject, { ...admission, definition });
      }
    } catch {
      this.invalidate(server);
      state.status = "invalid-catalog";
      throw new Error("Invalid MCP catalog");
    }
    const hidden: ToolDefinition[] = [];
    for (const old of this.admissions.values())
      if (old.server === server) {
        const replacement = next.get(old.subject);
        if (replacement?.revision !== old.revision)
          this.options.getPolicy()?.invalidateSubject(old.subject);
        if (replacement === undefined) {
          old.live = false;
          hidden.push({
            ...old.definition,
            exposure: "hidden",
            execute: () => Promise.reject(new Error("MCP tool withdrawn")),
          });
        }
      }
    for (const [subject, admission] of next) {
      this.admissions.set(subject, admission);
      this.owners.set(admission.definition.name, subject);
    }
    state.connection = connection;
    return [...next.values()].map((admission) => admission.definition).concat(hidden);
  }

  private current(admission: Admission): boolean {
    const latest = this.admissions.get(admission.subject);
    return (
      !this.stopped &&
      this.servers.get(admission.server)?.enabled === true &&
      this.servers.get(admission.server)?.exposure !== "hidden" &&
      latest?.live === true &&
      latest.revision === admission.revision &&
      admission.connection.state === "connected" &&
      this.options.selected(admission.definition.name)
    );
  }

  private async invoke(
    admission: Admission,
    check: (args: unknown) => boolean,
    ...[id, params, signal, update, ctx]: Parameters<ToolDefinition["execute"]>
  ): ReturnType<ToolDefinition["execute"]> {
    if (!this.current(admission))
      throw new Error("MCP tool changed or unavailable; make a fresh call");
    const policy = this.options.getPolicy();
    if (policy === undefined) throw new Error("MCP policy unavailable");
    if (Buffer.byteLength(JSON.stringify(params)) > MESSAGE_LIMIT)
      throw new Error("MCP arguments exceed limits");
    const request = prepareApprovalRequest({
      subject: admission.subject,
      display: approvalPreview(`${admission.server}/${admission.rawName}`, params as JsonObject),
      arguments: params as JsonObject,
    });
    if (!check(request.arguments)) throw new Error("Invalid MCP tool arguments");
    const operationSignal =
      signal === undefined
        ? this.controller.signal
        : AbortSignal.any([signal, this.controller.signal]);
    const ui = approvalUi(ctx);
    const decision = await policy.evaluate(request, {
      signal: operationSignal,
      ...(ui === undefined ? {} : { ui }),
    });
    await this.options.getAuditor()?.decision(decision, admission.definition.name);
    if (!decision.allowed) throw new Error(`MCP tool denied: ${decision.reason}`);
    if (!this.current(admission) || operationSignal.aborted)
      throw new Error("MCP invocation changed or cancelled; make a fresh call");
    const server = this.servers.get(admission.server)!;
    if (server.active >= 16 || this.active >= 64) throw new Error("MCP server busy");
    server.active++;
    this.active++;
    const deadline = new AbortController();
    const timeout = setTimeout(() => deadline.abort(), server.resolved.policy.timeoutMs);
    const dispatchSignal = AbortSignal.any([operationSignal, deadline.signal]);
    try {
      const result = await this.guard.run(
        { current: () => this.current(admission), signal: dispatchSignal },
        () => admission.definition.execute(id, request.arguments, dispatchSignal, update, ctx),
      );
      if (dispatchSignal.aborted) throw new Error("MCP invocation cancelled or timed out");
      if (Buffer.byteLength(JSON.stringify(result)) > MESSAGE_LIMIT * 2)
        throw new Error("MCP result exceeds limits");
      return result;
    } catch {
      if (dispatchSignal.aborted && server.resolved.policy.transport === "stdio")
        await server.transport?.close();
      throw new ManagedToolExecutionError(
        deadline.signal.aborted ? "timeout" : operationSignal.aborted ? "cancelled" : "error",
      );
    } finally {
      clearTimeout(timeout);
      server.active--;
      this.active--;
    }
  }

  private createTransport(id: string): McpTransport {
    const state = this.servers.get(id);
    if (state === undefined || this.stopped || !state.enabled || state.resolved.status !== "ready")
      throw new Error("MCP server unavailable");
    const { resolved } = state;
    const policy = resolved.policy;
    const transport =
      this.options.transportFactory?.(resolved) ??
      (policy.transport === "http"
        ? new StreamableHttpTransport({
            url: resolved.url!,
            headers: { ...resolved.headers },
            maxMessageBytes: MESSAGE_LIMIT,
            fetch: async (url, init) => {
              const method: unknown =
                init?.method === "POST" && typeof init.body === "string"
                  ? (JSON.parse(init.body) as { method?: unknown }).method
                  : undefined;
              let signal = init?.signal;
              if (method === "tools/call") {
                const invocation = this.guard.getStore();
                if (invocation === undefined || !invocation.current() || invocation.signal.aborted)
                  throw new Error("MCP dispatch invalidated");
                signal =
                  signal == null ? invocation.signal : AbortSignal.any([signal, invocation.signal]);
              } else if (method === "notifications/cancelled") {
                // Cancellation is protocol cleanup, not another tool dispatch. It may
                // run after the originating invocation's signal has already aborted.
                const deadline = AbortSignal.timeout(1000);
                signal = signal == null ? deadline : AbortSignal.any([signal, deadline]);
              }
              return fetch(url, {
                ...init,
                redirect: "error",
                ...(signal === undefined ? {} : { signal }),
              });
            },
          })
        : new StdioTransport({
            command: policy.command,
            args: policy.args,
            cwd: this.options.cwd,
            env: { ...resolved.environment },
            inheritEnv: false,
            stderr: "pipe",
            maxMessageBytes: MESSAGE_LIMIT,
            maxStderrBytes: 64 * 1024,
          }));
    transport.onClose(() => {
      if (state.transport === transport) {
        state.status = "disconnected";
        this.invalidate(id);
      }
    });
    const send = transport.send.bind(transport);
    transport.send = async (message) => {
      if (Buffer.byteLength(JSON.stringify(message)) > MESSAGE_LIMIT) {
        await transport.close();
        throw new Error("MCP message exceeds limits");
      }
      if ("method" in message && message.method === "tools/call") {
        const invocation = this.guard.getStore();
        if (invocation === undefined || !invocation.current() || invocation.signal.aborted)
          throw new Error("MCP dispatch not authorized");
      }
      return send(message);
    };
    state.transport = transport;
    return transport;
  }

  public diagnostics(serverId?: string): string {
    const lines = ["MCP servers (host execution)"];
    for (const [id, state] of this.servers) {
      if (serverId !== undefined && id !== serverId) continue;
      lines.push(
        `${id}: ${state.resolved.policy.transport}, ${state.exposure}, ${state.enabled ? state.status : "disabled by user"}`,
      );
      if (serverId !== undefined)
        for (const tool of this.admissions.values())
          if (tool.server === id && tool.live) {
            lines.push(
              `  ${tool.rawName}: ${tool.policy.mode}, rule ${tool.rule}, session grant ${this.options.getPolicy()?.hasSessionGrant(tool.subject) === true ? "active" : "none"}`,
            );
          }
    }
    if (lines.length === 1) lines.push(serverId === undefined ? "none" : "Unknown MCP server");
    return lines.join("\n");
  }

  public async close(): Promise<void> {
    this.stopped = true;
    this.controller.abort();
    for (const id of this.servers.keys()) this.invalidate(id);
    await Promise.allSettled(
      [...this.servers.values()].map((server) => server.transport?.close() ?? Promise.resolve()),
    );
    await Promise.allSettled([...this.pending]);
  }
}
