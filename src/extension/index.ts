import type {
  ExtensionAPI,
  ExtensionFactory,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ToolAuditor } from "../audit/tools.js";

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
  prepareApprovalRequest,
  type JsonObject,
  type ApprovalRequest,
  TOOL_NAMES,
} from "../permissions/index.js";
import { SandboxExecutionError } from "../../packages/sandbox-extension/src/runtime/index.js";
import {
  formatSandboxMounts,
  formatSandboxPolicy,
  formatSandboxSummary,
  diagnosticSubjects,
  sandboxCommandArguments,
} from "./diagnostics.js";
import { createSandboxExtension } from "../../packages/sandbox-extension/src/factory.js";
import type { ExtensionDependencies, SandboxExecutor } from "./types.js";
import { approvalUi, approvalPreview } from "../permissions/index.js";
import { ManagedMcpRuntime } from "../mcp/runtime.js";
import { createManagedCodemodeExtension } from "../codemode/index.js";
import { isManagedToolSelected, selectManagedActiveTools } from "../runtime/arguments.js";

interface ExtensionState {
  executor: SandboxExecutor | undefined;
  policy: PolicyEngine | undefined;
  config: SandboxConfig | undefined;
  managedExtensions: readonly ManagedExtensionInstance[];
  piToolExtensions: readonly PiToolExtension[];
  hostExecutors: Readonly<Record<string, HostCommandExecutor>>;
  started: boolean;
  stopped: boolean;
  auditor: ToolAuditor | undefined;
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

const MANAGED_TOOL_CALL_SUMMARY_MAX_BYTES = 1024;
function sandboxCommandUsage(config?: SandboxConfig): string {
  const subjects = config === undefined ? "<tool>" : diagnosticSubjects(config).join("|");
  return `Usage: /sandbox [mounts | policy [${subjects}] | mcp [server]]`;
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
    display: approvalPreview(subject, rawArguments),
    arguments: rawArguments,
  });
  await authorizeRequest(state, request, ctx, signal);
  return request.arguments as T;
}

async function authorizeRequest(
  state: ExtensionState,
  request: ApprovalRequest,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<void> {
  if (state.policy === undefined || state.stopped) {
    throw new Error("Pi Sandbox is not available");
  }
  const ui = approvalUi(ctx);
  const decision = await state.policy.evaluate(request, {
    ...(ui === undefined ? {} : { ui }),
    ...(signal === undefined ? {} : { signal }),
  });
  await state.auditor?.decision(decision, request.subject);
  if (!decision.allowed)
    throw new Error(`Pi Sandbox denied ${request.subject}: ${decision.reason}`);
  if (signal?.aborted === true) throw new SandboxExecutionError("sandbox_aborted");
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
    if (codePoint !== undefined && (codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)))
      return true;
  }
  return false;
}

export function createPiSandboxExtension(dependencies: ExtensionDependencies): ExtensionFactory {
  return async (pi) => {
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
      auditor: undefined,
    };

    const starts: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
    const stops: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
    const features = dependencies.features;
    const mcp =
      features === undefined
        ? undefined
        : new ManagedMcpRuntime({
            cwd: dependencies.cwd,
            servers: features.servers,
            selected: features.selected,
            autoEnableCodemode: features.config.codemode.enabled && features.selected("codemode"),
            ...(features.mcpPreferences === undefined
              ? {}
              : { preferences: features.mcpPreferences }),
            getPolicy: () => state.policy,
            getAuditor: () => state.auditor,
          });
    const childApi = new Proxy(pi, {
      get(target, property): unknown {
        if (property === "on")
          return (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
            if (name === "session_start") starts.push(handler);
            else if (name === "session_shutdown") stops.push(handler);
            else (target.on as (name: string, handler: unknown) => void)(name, handler);
          };
        if (property === "registerTool")
          return (definition: ToolDefinition) => {
            if (definition.name !== "codemode") {
              target.registerTool(definition);
              return;
            }
            target.registerTool({
              ...definition,
              exposure: features?.selected("codemode") === true ? "model-only" : "hidden",
              async execute(...args) {
                if (!state.started || state.stopped || features?.selected("codemode") !== true)
                  throw new Error("Code mode unavailable");
                const audited =
                  state.auditor?.wrap(definition, "host", undefined, undefined, undefined, true) ??
                  definition;
                return audited.execute(...args);
              },
            });
          };
        return Reflect.get(target, property);
      },
    });

    const sandboxTools = new Map<string, ToolDefinition>();
    await createSandboxExtension({
      cwd: dependencies.cwd,
      getExecutor: () => {
        if (state.executor === undefined || state.stopped)
          throw new Error("Pi Sandbox is not available");
        return state.executor;
      },
      tools: TOOL_NAMES,
      async authorize(request, ctx, signal) {
        await authorize(state, request.subject, request.arguments, ctx, signal);
      },
      userBash: true,
      executionScope:
        dependencies.executor.backend === "bubblewrap"
          ? "inside the Bubblewrap sandbox"
          : dependencies.executor.backend === "smolvm"
            ? "inside the smolvm Linux virtual machine"
            : "directly on the host as the current user",
    })(
      new Proxy(pi, {
        get(target, property): unknown {
          if (property === "registerTool")
            return (definition: ToolDefinition) => sandboxTools.set(definition.name, definition);
          return Reflect.get(target, property);
        },
      }),
    );

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
        if (argumentsList[0] === "mcp" && argumentsList.length <= 2)
          return notify(mcp?.diagnostics(argumentsList[1]) ?? "MCP servers (host execution)\nnone");
        if (argumentsList.length === 0) {
          return notify(
            formatSandboxSummary({
              initialized: state.executor !== undefined && !state.stopped,
              codemodeEnabled: config.codemode.enabled,
              mcpServerCount: Object.keys(config.mcp.servers).length,
              cwd: dependencies.cwd,
              configPath: dependencies.configPath,
              modelsFile: config.modelsFile,
              execution: config.execution,
              filesystem: config.filesystem,
              identity: config.identity,
              network: config.network,
              extensions: Object.keys(config.extensions),
              userStateDir: dependencies.userStateDir,
            }),
          );
        }
        if (argumentsList.length === 1 && argumentsList[0] === "mounts") {
          return notify(formatSandboxMounts(dependencies.cwd, config.execution, config.filesystem));
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

    pi.on("session_start", async (_event, ctx) => {
      if (state.started || state.stopped) {
        state.stopped = true;
        state.executor = undefined;
        state.policy?.clearSessionGrants();
        await state.auditor?.end();
        throw new Error("Pi Sandbox session was started more than once");
      }
      state.started = true;
      const config = await dependencies.loadConfig();
      state.config = config;
      state.policy = new PolicyEngine(config.tools, mcp?.resolveSubject);
      await dependencies.onSessionStart?.(ctx.sessionManager.getSessionFile());
      try {
        await dependencies.executor.probe();
        state.executor = dependencies.executor;
        if (config.audit.enabled) {
          if (dependencies.auditClient === undefined)
            throw new Error("Pi Sandbox tool logging client is not initialized");
          state.auditor = new ToolAuditor(
            dependencies.auditClient,
            dependencies.cwd,
            dependencies.executor.home,
          );
          await state.auditor.start(ctx);
        }
        const registrationApi = new Proxy(pi, {
          get(target, property): unknown {
            if (property !== "registerTool") return Reflect.get(target, property);
            return (definition: ToolDefinition) => {
              const managed = state.managedExtensions.find((instance) =>
                instance.extension.tools.some((tool) => tool.name === definition.name),
              );
              const compiled = state.piToolExtensions.find((extension) =>
                extension.toolNames.includes(definition.name),
              );
              const extension = managed?.extension.id ?? compiled?.id;
              const auditTarget = managed?.extension.tools.find(
                (tool) => tool.name === definition.name,
              )?.auditTarget;
              target.registerTool(
                config.tools[definition.name]?.audit === true && state.auditor !== undefined
                  ? state.auditor.wrap(
                      definition,
                      extension === undefined ? dependencies.executor.backend : "host",
                      extension,
                      auditTarget,
                    )
                  : definition,
              );
            };
          },
        });
        const enabled = new Set(
          Object.keys(config.tools).filter(
            (name) =>
              state.policy?.isEnabled(name) === true &&
              isManagedToolSelected(dependencies.toolArguments ?? [], name),
          ),
        );
        for (const definition of sandboxTools.values()) {
          if (enabled.has(definition.name)) registrationApi.registerTool(definition);
        }
        registerManagedTools(registrationApi, state, enabled, dependencies.cwd);
        await registerPiToolExtensions(registrationApi, state, enabled);
        if (config.codemode.enabled && features?.selected("codemode") === true)
          enabled.add("codemode");
        pi.setActiveTools(
          selectManagedActiveTools(
            dependencies.toolArguments ?? [],
            enabled,
            pi.getSettings().defaultTools,
          ),
        );
        for (const start of starts) await start(_event, ctx);
      } catch (error) {
        state.executor = undefined;
        state.stopped = true;
        throw error;
      }
    });

    pi.on("session_shutdown", async (event, ctx) => {
      state.stopped = true;
      try {
        const cleanup = await Promise.allSettled([
          mcp?.close() ?? Promise.resolve(),
          ...stops.map((stop) => Promise.resolve().then(() => stop(event, ctx))),
        ]);
        state.policy?.clearSessionGrants();
        state.executor = undefined;
        await state.auditor?.end();
        if (cleanup.some((result) => result.status === "rejected"))
          throw new Error("Managed tool shutdown failed");
      } finally {
        if (event?.reason === "quit") await dependencies.onProcessShutdown?.();
      }
    });

    const factories =
      features === undefined
        ? []
        : [
            createManagedCodemodeExtension(features.config.codemode),
            ...(features.servers.some((server) => server.status === "ready")
              ? [mcp!.extension()]
              : []),
          ].filter((factory): factory is ExtensionFactory => factory !== undefined);
    for (const factory of factories) await factory(childApi);

    // Run after MCP's startup hook so autoactivation is reflected in the prompt.
    pi.on("before_agent_start", (event) => {
      const active = new Set(pi.getActiveTools());
      const sections = event.systemPromptOptions.sections;
      delete sections.pi_sandbox_tool_guidance;
      if (!active.has("codemode")) return;
      sections.pi_sandbox_tool_guidance =
        "Prefer dedicated tools for file operations and code mode for coordinating tool calls or processing results." +
        (active.has("bash")
          ? " Use Bash for running programs, builds, tests, and operations without a suitable dedicated tool."
          : "");
    });
  };
}

export type { ExtensionDependencies, SandboxExecutor } from "./types.js";
