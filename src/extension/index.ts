import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  truncateTail,
  type ExtensionAPI,
  type ExtensionContext,
  type ExtensionHandler,
  type ToolDefinition,
  type UserBashEvent,
  type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import type { SandboxConfig, ToolName } from "../domain/index.js";
import type {
  HostCommandExecutor,
  JsonObject as ManagedJsonObject,
  ManagedExtensionInstance,
  ManagedToolDefinition,
} from "../managed-extensions/sdk.js";
import type { PiToolExtension } from "../managed-extensions/sdk.js";
import {
  PolicyEngine,
  createApprovalPolicies,
  prepareApprovalRequest,
  type ApprovalPromptDecision,
  type ApprovalUi,
  type JsonObject,
} from "../policy/index.js";
import { SandboxExecutionError } from "../sandbox/index.js";
import {
  executeEdit,
  executeFind,
  executeGrep,
  executeLs,
  executeRead,
  executeWrite,
  normalizeSandboxPath,
} from "./executor-operations.js";
import {
  formatSandboxMounts,
  formatSandboxPolicy,
  formatSandboxSummary,
  diagnosticSubjects,
  sandboxCommandArguments,
} from "./diagnostics.js";
import type { ExtensionDependencies, SandboxExecutor } from "./types.js";

interface ExtensionState {
  executor: SandboxExecutor | undefined;
  policy: PolicyEngine | undefined;
  config: SandboxConfig | undefined;
  managedExtensions: readonly ManagedExtensionInstance[];
  piToolExtensions: readonly PiToolExtension[];
  hostExecutors: Readonly<Record<string, HostCommandExecutor>>;
  started: boolean;
  stopped: boolean;
}

async function registerPiToolExtensions(
  pi: ExtensionAPI,
  state: ExtensionState,
  enabled: ReadonlySet<ToolName>,
): Promise<void> {
  for (const extension of state.piToolExtensions) {
    const captured = new Map<string, ToolDefinition>();
    let acceptingRegistrations = true;
    const registerTool = (definition: ToolDefinition): void => {
      if (!acceptingRegistrations) {
        throw new Error(`Pi tool extension ${extension.id} registered a tool after startup`);
      }
      if (
        typeof definition !== "object" ||
        definition === null ||
        typeof definition.name !== "string" ||
        typeof definition.label !== "string" ||
        typeof definition.description !== "string" ||
        typeof definition.execute !== "function" ||
        typeof definition.parameters !== "object" ||
        definition.parameters === null
      ) {
        throw new Error(`Pi tool extension ${extension.id} registered an invalid tool`);
      }
      if (captured.has(definition.name)) {
        throw new Error(
          `Pi tool extension ${extension.id} registered duplicate tool ${definition.name}`,
        );
      }
      captured.set(definition.name, definition);
    };
    const allowed = Object.freeze({
      registerTool,
      exec: pi.exec.bind(pi),
    });
    const api = new Proxy(allowed, {
      get(target, property): unknown {
        if (property === "registerTool") return target.registerTool;
        if (property === "exec") return target.exec;
        throw new Error(
          `Pi tool extension ${extension.id} attempted to use unsupported ExtensionAPI member ${String(property)}`,
        );
      },
    }) as unknown as ExtensionAPI;
    try {
      await extension.factory(api);
    } finally {
      acceptingRegistrations = false;
    }
    const names = [...captured.keys()];
    const actualNames = [...names].sort();
    const declaredNames = [...extension.toolNames].sort();
    if (JSON.stringify(actualNames) !== JSON.stringify(declaredNames)) {
      throw new Error(
        `Pi tool extension ${extension.id} registered [${names.join(", ")}] but declared [${extension.toolNames.join(", ")}]`,
      );
    }
    for (const definition of captured.values()) {
      if (!enabled.has(definition.name)) continue;
      pi.registerTool(policyWrappedPiTool(definition, state));
    }
  }
}

function policyWrappedPiTool(definition: ToolDefinition, state: ExtensionState): ToolDefinition {
  return {
    ...definition,
    async execute(id, params, signal, onUpdate, ctx) {
      const arguments_ = await authorize(
        state,
        definition.name,
        params as ManagedJsonObject,
        ctx,
        signal,
      );
      return definition.execute(id, arguments_, signal, onUpdate, ctx);
    },
  } as ToolDefinition;
}

const SHELL_OUTPUT_LIMIT = 8 * 1024 * 1024;
const SHELL_UPDATE_THROTTLE_MS = 100;
const MANAGED_TOOL_CALL_SUMMARY_MAX_BYTES = 1024;
function sandboxCommandUsage(config?: SandboxConfig): string {
  const subjects = config === undefined ? "<tool>" : diagnosticSubjects(config).join("|");
  return `Usage: /sandbox [mounts | policy [${subjects}]]`;
}

interface ShellSnapshot {
  readonly output: string;
  readonly truncated: boolean;
  readonly details: { readonly truncation?: ReturnType<typeof truncateTail> } | undefined;
}

class ShellOutputCollector {
  private readonly chunks: Buffer[] = [];
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private lastUpdateAt = 0;

  public constructor(private readonly update?: (snapshot: ShellSnapshot) => void) {}

  public append(chunk: Buffer): void {
    this.chunks.push(Buffer.from(chunk));
    this.scheduleUpdate();
  }

  public hasOutput(): boolean {
    return this.chunks.length > 0;
  }

  public appendFallback(stdout: Buffer, stderr: Buffer): void {
    if (this.hasOutput()) return;
    if (stdout.length > 0) this.chunks.push(Buffer.from(stdout));
    if (stderr.length > 0) this.chunks.push(Buffer.from(stderr));
  }

  public finish(): ShellSnapshot {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const snapshot = this.snapshot();
    if (this.dirty) this.update?.(snapshot);
    this.dirty = false;
    return snapshot;
  }

  private snapshot(): ShellSnapshot {
    const truncation = truncateTail(
      sanitizeShellOutput(Buffer.concat(this.chunks).toString("utf8")),
    );
    const notice = truncation.truncated
      ? `\n\n[Showing the bounded tail of command output; earlier output was discarded.]`
      : "";
    return {
      output: `${truncation.content}${notice}`,
      truncated: truncation.truncated,
      details: truncation.truncated ? { truncation } : undefined,
    };
  }

  private scheduleUpdate(): void {
    if (this.update === undefined) return;
    this.dirty = true;
    const delay = SHELL_UPDATE_THROTTLE_MS - (Date.now() - this.lastUpdateAt);
    if (delay <= 0) {
      this.emitUpdate();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.emitUpdate();
    }, delay);
  }

  private emitUpdate(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastUpdateAt = Date.now();
    this.update?.(this.snapshot());
  }
}

function sanitizeShellOutput(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index);
    if (code === undefined) continue;
    if (code > 0xffff) index += 1;
    if (code === 0x1b || code === 0x9b) {
      const next = code === 0x1b ? value.codePointAt(index + 1) : 0x5b;
      if (next === 0x5d) {
        if (code === 0x1b) index += 1;
        while (index + 1 < value.length) {
          index += 1;
          const current = value.codePointAt(index);
          if (current === 0x07 || current === 0x9c) break;
          if (current === 0x1b && value.codePointAt(index + 1) === 0x5c) {
            index += 1;
            break;
          }
        }
        continue;
      }
      if (next === 0x5b) {
        if (code === 0x1b) index += 1;
        while (index + 1 < value.length) {
          index += 1;
          const current = value.codePointAt(index) ?? 0;
          if (current >= 0x40 && current <= 0x7e) break;
        }
        continue;
      }
      continue;
    }
    if (code === 0x0d) continue;
    if (code === 0x09 || code === 0x0a) output += String.fromCodePoint(code);
    else if (code > 0x1f && !(code >= 0x7f && code <= 0x9f) && !(code >= 0xfff9 && code <= 0xfffb))
      output += String.fromCodePoint(code);
  }
  return output;
}

function approvalUi(ctx: ExtensionContext): ApprovalUi | undefined {
  if (!ctx.hasUI) return undefined;
  return {
    async prompt(prompt, signal): Promise<ApprovalPromptDecision> {
      const choices = prompt.allowForSession
        ? ["Allow once", "Allow for session", "Deny"]
        : ["Allow once", "Deny"];
      const selected = await ctx.ui.select(`Allow ${prompt.request.subject}?`, choices, { signal });
      if (selected === "Allow once") return "allow_once";
      if (selected === "Allow for session") return "allow_session";
      return "deny";
    },
  };
}

async function authorize<T extends JsonObject>(
  state: ExtensionState,
  subject: ToolName,
  rawArguments: T,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<T> {
  if (state.policy === undefined || state.stopped) {
    throw new Error("Pi Sandbox is not available");
  }
  const request = prepareApprovalRequest({
    subject,
    display: subject,
    arguments: rawArguments,
  });
  const ui = approvalUi(ctx);
  const decision = await state.policy.evaluate(request, {
    ...(ui === undefined ? {} : { ui }),
    ...(signal === undefined ? {} : { signal }),
  });
  if (!decision.allowed) throw new Error(`Pi Sandbox denied ${subject}: ${decision.reason}`);
  return request.arguments as T;
}

function registerManagedTools(
  pi: ExtensionAPI,
  state: ExtensionState,
  enabled: ReadonlySet<ToolName>,
  cwd: string,
): void {
  for (const instance of state.managedExtensions) {
    for (const definition of instance.extension.tools) {
      if (!enabled.has(definition.name)) continue;
      pi.registerTool(managedPiTool(definition, instance, state, cwd));
    }
  }
}

function managedPiTool(
  definition: ManagedToolDefinition,
  instance: ManagedExtensionInstance,
  state: ExtensionState,
  cwd: string,
): ToolDefinition {
  return {
    name: definition.name,
    label: definition.label,
    description: definition.description,
    ...(definition.promptSnippet === undefined ? {} : { promptSnippet: definition.promptSnippet }),
    ...(definition.promptGuidelines === undefined
      ? {}
      : { promptGuidelines: [...definition.promptGuidelines] }),
    ...(definition.executionMode === undefined ? {} : { executionMode: definition.executionMode }),
    parameters: definition.parameters,
    ...(definition.formatCall === undefined
      ? {}
      : {
          renderCall(args, theme, context) {
            const component =
              context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
            const summary = managedToolCallSummary(definition, args);
            component.setText(
              `${theme.fg("toolTitle", theme.bold(definition.name))}${
                summary === undefined ? "" : ` ${theme.fg("accent", summary)}`
              }`,
            );
            return component;
          },
        }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const arguments_ = await authorize(
        state,
        definition.name,
        params as ManagedJsonObject,
        ctx,
        signal,
      );
      const host = state.hostExecutors[instance.extension.id];
      if (host === undefined) throw new Error("Pi Sandbox host executor is not initialized");
      const result = await definition.execute(
        arguments_,
        Object.freeze({
          cwd,
          config: instance.config,
          signal: signal ?? new AbortController().signal,
          host,
        }),
      );
      return { content: [...result.content], details: result.details };
    },
  };
}

function managedToolCallSummary(
  definition: ManagedToolDefinition,
  arguments_: unknown,
): string | undefined {
  if (definition.formatCall === undefined) return undefined;
  let summary: string | undefined;
  try {
    summary = definition.formatCall(arguments_ as Readonly<Partial<ManagedJsonObject>>);
  } catch {
    return undefined;
  }
  if (
    typeof summary !== "string" ||
    summary.trim().length === 0 ||
    hasControlCharacter(summary) ||
    Buffer.byteLength(summary) > MANAGED_TOOL_CALL_SUMMARY_MAX_BYTES
  ) {
    return undefined;
  }
  return summary;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function registerTools(
  pi: ExtensionAPI,
  state: ExtensionState,
  enabled: ReadonlySet<ToolName>,
  cwd: string,
): void {
  const executor = state.executor;
  if (executor === undefined) throw new Error("Pi Sandbox executor is not initialized");
  const executionScope =
    executor.backend === "bubblewrap"
      ? "inside the Bubblewrap sandbox"
      : "directly on the host as the current user";

  if (enabled.has("read")) {
    const base = withoutToolFields(createReadToolDefinition(cwd), "execute");
    pi.registerTool({
      ...base,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const args = await authorize(
          state,
          "read",
          { ...params, path: normalizeSandboxPath(cwd, params.path, executor.home) },
          ctx,
          signal,
        );
        return executeRead(executor, args, cwd, signal);
      },
    });
  }
  if (enabled.has("write")) {
    const base = withoutToolFields(createWriteToolDefinition(cwd), "execute");
    pi.registerTool({
      ...base,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const args = await authorize(
          state,
          "write",
          { ...params, path: normalizeSandboxPath(cwd, params.path, executor.home) },
          ctx,
          signal,
        );
        return executeWrite(executor, args, cwd, signal);
      },
    });
  }
  if (enabled.has("edit")) {
    // The stock edit call renderer performs an unapproved host filesystem preview. Keep every
    // other 0.84.3 definition field, including prepareArguments and the settled-result renderer.
    const base = withoutToolFields(createEditToolDefinition(cwd), "execute", "renderCall");
    pi.registerTool({
      ...base,
      renderCall(args, theme, context) {
        const component =
          context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
        const path = typeof args?.path === "string" ? args.path : "[invalid path]";
        component.setText(
          `${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path)}`,
        );
        return component;
      },
      async execute(_id, params, signal, _onUpdate, ctx) {
        const args = await authorize(
          state,
          "edit",
          { ...params, path: normalizeSandboxPath(cwd, params.path, executor.home) },
          ctx,
          signal,
        );
        return executeEdit(executor, args, cwd, signal);
      },
    });
  }
  if (enabled.has("ls")) {
    const base = withoutToolFields(createLsToolDefinition(cwd), "execute");
    pi.registerTool({
      ...base,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const args = await authorize(
          state,
          "ls",
          { ...params, path: normalizeSandboxPath(cwd, params.path ?? ".", executor.home) },
          ctx,
          signal,
        );
        return executeLs(executor, args, cwd, signal);
      },
    });
  }
  if (enabled.has("find")) {
    const base = withoutToolFields(createFindToolDefinition(cwd), "execute");
    pi.registerTool({
      ...base,
      description: `Search for files ${executionScope} using GNU find glob semantics: patterns without a slash match basenames (-name); patterns with a slash match paths relative to the search root (-path). Returns relative paths and skips .git and node_modules.`,
      promptSnippet: `Find files with GNU find glob patterns ${executionScope}`,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const args = await authorize(
          state,
          "find",
          { ...params, path: normalizeSandboxPath(cwd, params.path ?? ".", executor.home) },
          ctx,
          signal,
        );
        return executeFind(executor, args, cwd, signal);
      },
    });
  }
  if (enabled.has("grep")) {
    const base = withoutToolFields(createGrepToolDefinition(cwd), "execute");
    pi.registerTool({
      ...base,
      description: `Search file contents ${executionScope}. Returns matching lines with file paths and line numbers and skips .git directories.`,
      promptSnippet: `Search file contents ${executionScope}`,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const args = await authorize(
          state,
          "grep",
          { ...params, path: normalizeSandboxPath(cwd, params.path ?? ".", executor.home) },
          ctx,
          signal,
        );
        return executeGrep(executor, args, cwd, signal);
      },
    });
  }
  if (enabled.has("bash")) {
    // Keep Pi's schema and renderers, but not its host-side OutputAccumulator, which writes
    // truncated command output to the host /tmp outside the sandbox boundary.
    const base = withoutToolFields(createBashToolDefinition(cwd), "execute");
    pi.registerTool({
      ...base,
      description: `Execute a Bash command ${executionScope}. Output is a bounded tail; earlier output is discarded rather than written to a host temporary file. Timeout defaults to 120 seconds and may be set from greater than 0 through 600 seconds.`,
      promptGuidelines: [],
      parameters: {
        ...base.parameters,
        properties: {
          ...base.parameters.properties,
          timeout: {
            ...base.parameters.properties.timeout,
            description: "Timeout in seconds (default 120, maximum 600)",
            exclusiveMinimum: 0,
            maximum: 600,
          },
        },
      },
      async execute(_id, params, signal, onUpdate, ctx) {
        const args = await authorize(state, "bash", { ...params, cwd }, ctx, signal);
        const output = new ShellOutputCollector((snapshot) => {
          onUpdate?.({
            content: [{ type: "text", text: snapshot.output }],
            details: snapshot.details,
          });
        });
        let result;
        try {
          result = await executor.execute(
            {
              argv: [executor.commands.bash, "-c", args.command],
              ...(args.timeout === undefined
                ? {}
                : { timeoutMs: bashTimeoutMilliseconds(args.timeout) }),
              maxOutputBytes: SHELL_OUTPUT_LIMIT,
            },
            {
              ...(signal === undefined ? {} : { signal }),
              onStdout: (chunk) => output.append(chunk),
              onStderr: (chunk) => output.append(chunk),
            },
          );
        } catch (error) {
          const snapshot = output.finish();
          if (signal?.aborted === true || isSandboxAbort(error))
            throw new Error(withShellStatus(snapshot.output, "Command aborted"));
          throw new Error(
            withShellStatus(
              snapshot.output,
              error instanceof Error ? error.message : "Sandbox command failed",
            ),
          );
        }
        output.appendFallback(result.stdout, result.stderr);
        const snapshot = output.finish();
        if (result.exitCode !== 0)
          throw new Error(
            withShellStatus(snapshot.output, `Command exited with code ${String(result.exitCode)}`),
          );
        return {
          content: [{ type: "text", text: snapshot.output || "(no output)" }],
          details: snapshot.details,
        };
      },
    });
  }
}

function withoutToolFields<T extends object, K extends keyof T>(
  source: T,
  ...keys: K[]
): Omit<T, K> {
  const copy = { ...source };
  for (const key of keys) Reflect.deleteProperty(copy, key);
  return copy;
}

function withShellStatus(output: string, status: string): string {
  return output.length > 0 ? `${output}\n\n${status}` : status;
}

function isSandboxAbort(error: unknown): boolean {
  return error instanceof SandboxExecutionError && error.code === "sandbox_aborted";
}

function bashTimeoutMilliseconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
    throw new Error("Bash timeout must be greater than 0 and at most 600 seconds");
  }
  return Math.ceil(seconds * 1_000);
}

function failedUserShell(
  reason: string,
  options: { readonly cancelled?: boolean; readonly truncated?: boolean } = {},
): UserBashEventResult {
  return {
    result: {
      output: reason,
      exitCode: options.cancelled === true ? undefined : 1,
      cancelled: options.cancelled ?? false,
      truncated: options.truncated ?? false,
    },
  };
}

export function createPiSandboxExtension(
  dependencies: ExtensionDependencies,
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const state: ExtensionState = {
      executor: undefined,
      policy: undefined,
      config: undefined,
      managedExtensions: dependencies.managedExtensions ?? [],
      piToolExtensions: dependencies.piToolExtensions ?? [],
      hostExecutors: Object.freeze(
        Object.fromEntries(
          Object.entries(dependencies.hostExecutors ?? {}).map(([extensionId, executor]) => [
            extensionId,
            Object.freeze({ execute: executor.execute.bind(executor) }),
          ]),
        ),
      ),
      started: false,
      stopped: false,
    };

    pi.registerCommand("sandbox", {
      description: "Show Pi Sandbox status, mounts, or effective policy",
      getArgumentCompletions(argumentPrefix) {
        const matches = sandboxCommandArguments(state.config).filter((argument) =>
          argument.startsWith(argumentPrefix),
        );
        return matches.length === 0
          ? null
          : matches.map((argument) => ({ value: argument, label: argument }));
      },
      handler: (argumentsText, ctx) => {
        const notify = (message: string, type?: "info" | "warning" | "error") => {
          ctx.ui.notify(message, type);
          return Promise.resolve();
        };
        const config = state.config;
        const policy = state.policy;
        if (config === undefined || policy === undefined) {
          return notify("Pi Sandbox is unavailable", "warning");
        }
        const argumentsList = argumentsText
          .trim()
          .split(/\s+/u)
          .filter((value) => value.length > 0);
        if (argumentsList.length === 0) {
          return notify(
            formatSandboxSummary({
              initialized: state.executor !== undefined && !state.stopped,
              cwd: dependencies.cwd,
              configPath: dependencies.configPath,
              modelsFile: config.modelsFile,
              execution: config.execution,
              identity: config.identity,
              network: config.network,
              extensions: Object.keys(config.extensions),
              userStateDir: dependencies.userStateDir,
            }),
          );
        }
        if (argumentsList.length === 1 && argumentsList[0] === "mounts") {
          return notify(formatSandboxMounts(dependencies.cwd, config.execution));
        }
        if (argumentsList[0] === "policy" && argumentsList.length <= 2) {
          const subject = argumentsList[1];
          if (subject === undefined || diagnosticSubjects(config).includes(subject)) {
            const activeTools = new Set(pi.getActiveTools());
            const hostToolScopeEntries: Array<readonly [string, string]> = [
              ...state.managedExtensions.flatMap((instance) =>
                instance.extension.tools.map((tool) => [tool.name, tool.diagnosticScope] as const),
              ),
              ...state.piToolExtensions.flatMap((extension) =>
                extension.toolNames.map(
                  (toolName) => [toolName, `pi.extension.${extension.id}`] as const,
                ),
              ),
            ];
            const hostToolScopes = Object.freeze(Object.fromEntries(hostToolScopeEntries));
            return notify(
              formatSandboxPolicy(
                {
                  config,
                  hasSessionGrant: (candidate) => policy.hasSessionGrant(candidate),
                  isToolActive: (candidate) => activeTools.has(candidate),
                  hostToolScopes,
                },
                subject,
              ),
            );
          }
        }
        return notify(sandboxCommandUsage(config), "warning");
      },
    });

    pi.on("session_start", async () => {
      if (state.started) throw new Error("Pi Sandbox session was started more than once");
      state.started = true;
      const config = await dependencies.loadConfig();
      state.config = config;
      state.policy = new PolicyEngine(createApprovalPolicies(config));
      try {
        state.executor = dependencies.executor;
        const enabled = new Set(
          Object.keys(config.tools).filter((name) => state.policy?.isEnabled(name) === true),
        );
        registerTools(pi, state, enabled, dependencies.cwd);
        registerManagedTools(pi, state, enabled, dependencies.cwd);
        await registerPiToolExtensions(pi, state, enabled);
        pi.setActiveTools([...(dependencies.activeTools ?? enabled)]);
      } catch (error) {
        state.executor = undefined;
        state.stopped = true;
        throw error;
      }
    });

    pi.on("session_shutdown", () => {
      state.stopped = true;
      state.policy?.clearSessionGrants();
      state.executor = undefined;
    });

    const userBashHandler: ExtensionHandler<UserBashEvent, UserBashEventResult> = async (
      event,
      ctx,
    ) => {
      let signal: AbortSignal | undefined;
      try {
        signal = ctx.signal;
      } catch (error) {
        return failedUserShell(
          error instanceof Error ? error.message : "Pi Sandbox user shell failed",
          { cancelled: true },
        );
      }
      try {
        const executor = state.executor;
        if (executor === undefined) throw new Error("Pi Sandbox executor is not initialized");
        const output = new ShellOutputCollector();
        let result;
        try {
          result = await executor.execute(
            {
              argv: [executor.commands.bash, "-c", event.command],
              maxOutputBytes: SHELL_OUTPUT_LIMIT,
            },
            {
              ...(signal === undefined ? {} : { signal }),
              onStdout: (chunk) => output.append(chunk),
              onStderr: (chunk) => output.append(chunk),
            },
          );
        } catch (error) {
          const snapshot = output.finish();
          if (signal?.aborted === true || isSandboxAbort(error)) {
            return failedUserShell(withShellStatus(snapshot.output, "Command aborted"), {
              cancelled: true,
              truncated: snapshot.truncated,
            });
          }
          return failedUserShell(
            withShellStatus(
              snapshot.output,
              error instanceof Error ? error.message : "Pi Sandbox user shell failed",
            ),
            { truncated: snapshot.truncated },
          );
        }
        output.appendFallback(result.stdout, result.stderr);
        const snapshot = output.finish();
        return {
          result: {
            output: snapshot.output,
            exitCode: result.exitCode ?? undefined,
            cancelled: false,
            truncated: snapshot.truncated,
          },
        };
      } catch (error) {
        return failedUserShell(
          error instanceof Error ? error.message : "Pi Sandbox user shell failed",
          signal?.aborted === true ? { cancelled: true } : {},
        );
      }
    };
    pi.on("user_bash", userBashHandler);
  };
}

export type { ExtensionDependencies, SandboxExecutor } from "./types.js";
