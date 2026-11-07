import type {
  ExtensionAPI,
  ExtensionFactory,
  ExtensionContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { ToolAuditor, type CommandClassAudit } from "../audit/tools.js";

import type { SandboxConfig, ToolName } from "../domain/index.js";
import type {
  HostCommandExecutor,
  JsonObject as ManagedJsonObject,
  ManagedExtensionInstance,
  ManagedToolDefinition,
} from "../managed-extensions/sdk.js";
import type { PiToolExtension } from "../managed-extensions/sdk.js";
import {
  COMMAND_CLASS_TOOL,
  MAXIMUM_ANALYSIS_ISSUE_BYTES,
  PolicyEngine,
  approvalPreview,
  approvalSubjectLabel,
  approvalUi,
  boundedDisplayText,
  commandClassLabel,
  hasCommandClassPolicies,
  prepareApprovalRequest,
  type ApprovalDecision,
  type JsonObject,
  type ApprovalRequest,
  TOOL_NAMES,
} from "../permissions/index.js";
import {
  BASH_ANALYSIS_ISSUE_CODES,
  COMMAND_CLASSES,
  type BashAnalysis,
  type BashCommandAnalyzer,
  type BashRequestClass,
  type BashStageCoverage,
} from "../permissions/bash/contracts.js";
import { freezeCommandStages, validCommandStages } from "../permissions/command-set-evidence.js";
import { snapshotJsonObject } from "../../packages/sandbox-extension/src/invocation.js";
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
import { ManagedMcpRuntime } from "../mcp/runtime.js";
import { createManagedCodemodeExtension } from "../codemode/index.js";
import { isManagedToolSelected, selectManagedActiveTools } from "../runtime/arguments.js";
import { createUserExportController } from "../exports/service.js";
import { toolEnvironmentPrompt } from "./environment-prompt.js";
import { assertCurrentManagedChild, currentManagedChild } from "../subagents/invocation.js";
import { createManagedSubagentHost } from "../subagents/host.js";
import { cleanExpiredSubagents } from "../subagents/retention.js";
import { beforeManagedQuit } from "../subagents/quit.js";
import {
  SUBAGENT_TOOL_NAMES,
  managedToolPolicySubject,
  policyToolNames,
} from "../domain/subagents.js";
import { createSubagentsExtension } from "../../packages/subagents-extension/src/factory.js";
import type { SubagentController } from "../../packages/subagents-extension/src/contracts.js";
import { closeSubagentPreview } from "../../packages/subagents-extension/src/presentation.js";
import { createOptionalExtensions, optionalExtensionGuidance } from "./optional.js";
import {
  registerExtensionPreferencesCommand,
  type ExtensionPreferences,
} from "../extension-preferences/index.js";

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
  bashAnalyzer: BashCommandAnalyzer | undefined;
  beforeApproval?: () => void;
  preferences?: ExtensionPreferences;
}

/** Analyzer result bound into one approval request. */
interface CommandClassification {
  readonly commandClass: BashRequestClass;
  readonly version: number;
  readonly stages?: readonly BashStageCoverage[];
  /** Bounded first analyzer issue for an unclassified command. */
  readonly issue?: string;
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
  return `Usage: /sandbox [save | mounts | policy [${subjects}] | mcp [server]]`;
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
  if (state.preferences?.permitsTool(subject) === false)
    throw new Error(`Optional extension is disabled for ${subject}`);
  let arguments_: JsonObject = rawArguments;
  let classification: CommandClassification | undefined;
  if (subject === COMMAND_CLASS_TOOL && hasCommandClassPolicies(state.config?.tools[subject])) {
    // Analyze the same immutable snapshot that the approval request freezes.
    arguments_ = snapshotJsonObject(rawArguments);
    classification = await classifyCommand(state.bashAnalyzer, arguments_);
  }
  const request = prepareApprovalRequest({
    subject: managedToolPolicySubject(subject),
    display: approvalPreview(
      approvalSubjectLabel(subject, classification?.commandClass),
      arguments_,
    ),
    arguments: arguments_,
    ...(classification === undefined ? {} : { commandClass: classification.commandClass }),
    ...(classification?.stages === undefined ? {} : { commandStages: classification.stages }),
  });
  await authorizeRequest(state, request, ctx, signal, classification, subject);
  // A user can disable an extension while this call is waiting for approval.
  if (state.preferences?.permitsTool(subject) === false)
    throw new Error(`Optional extension is disabled for ${subject}`);
  return request.arguments as T;
}

/** Analyzer failures fail closed: the request stays unclassified and keeps the main policy. */
async function classifyCommand(
  analyzer: BashCommandAnalyzer | undefined,
  arguments_: JsonObject,
): Promise<CommandClassification> {
  if (analyzer === undefined)
    throw new Error("Pi Sandbox Bash command analyzer is not initialized");
  const version = analyzer.version;
  const unclassified = (issue: string): CommandClassification =>
    Object.freeze({
      commandClass: "unclassified",
      version,
      issue: boundedDisplayText(issue, MAXIMUM_ANALYSIS_ISSUE_BYTES),
    });
  const command = arguments_.command;
  if (typeof command !== "string") return unclassified("the command is not a string");
  let analysis: BashAnalysis;
  try {
    const result: unknown = await analyzer.analyze(command);
    if (!isBashAnalysis(result, version)) return unclassified("command analysis failed");
    analysis = result;
  } catch {
    return unclassified("command analysis failed");
  }
  return analysis.commandClass === "unclassified"
    ? unclassified(analysis.issue.message)
    : Object.freeze({
        commandClass: analysis.commandClass,
        version,
        ...(analysis.commandClass === "configured_command"
          ? { stages: freezeCommandStages(analysis.stages) }
          : {}),
      });
}

/** A classified result names every stage; an unclassified one carries a well-formed issue. */
function isBashAnalysis(value: unknown, version: number): value is BashAnalysis {
  if (typeof value !== "object" || value === null) return false;
  const result = value as Record<string, unknown>;
  if (result.version !== version) return false;
  if (result.commandClass === "configured_command") return validCommandStages(result.stages);
  if (result.commandClass === "unclassified") {
    const issue = result.issue;
    if (typeof issue !== "object" || issue === null) return false;
    const fields = issue as Record<string, unknown>;
    return (
      (BASH_ANALYSIS_ISSUE_CODES as readonly unknown[]).includes(fields.code) &&
      typeof fields.message === "string" &&
      fields.message.length > 0 &&
      (fields.offset === undefined ||
        (Number.isSafeInteger(fields.offset) && (fields.offset as number) >= 0))
    );
  }
  return (
    (COMMAND_CLASSES as readonly unknown[]).includes(result.commandClass) &&
    Array.isArray(result.commands) &&
    result.commands.length > 0 &&
    result.commands.every((name) => typeof name === "string" && name.length > 0)
  );
}

async function authorizeRequest(
  state: ExtensionState,
  request: ApprovalRequest,
  ctx: ExtensionContext,
  signal?: AbortSignal,
  classification?: CommandClassification,
  operation = request.subject,
): Promise<void> {
  if (state.policy === undefined || state.stopped) {
    throw new Error("Pi Sandbox is not available");
  }
  const ui = approvalUi(
    ctx,
    classification?.commandClass === "unclassified" ? classification.issue : undefined,
    state.beforeApproval,
  );
  assertCurrentManagedChild();
  currentManagedChild()?.setActivity("checking approval");
  const decision = await state.policy.evaluate(request, {
    ...(ui === undefined ? {} : { ui }),
    ...(signal === undefined ? {} : { signal }),
  });
  await state.auditor?.decision(decision, operation, classificationAudit(classification));
  assertCurrentManagedChild();
  currentManagedChild()?.setActivity("running tools");
  if (!decision.allowed) throw new Error(denialMessage(operation, decision, classification));
  if (signal?.aborted === true) throw new SandboxExecutionError("sandbox_aborted");
}

function classificationAudit(
  classification: CommandClassification | undefined,
): CommandClassAudit | undefined {
  return classification === undefined
    ? undefined
    : {
        command_class: classification.commandClass,
        known_read_only_version: classification.version,
        ...(classification.stages === undefined
          ? {}
          : {
              command_set_ids: [
                ...new Set(classification.stages.flatMap((stage) => stage.commandSets)),
              ].sort(),
            }),
      };
}

/** A policy denial names the analyzer's first issue so the model can adjust instead of retrying. */
function denialMessage(
  subject: ToolName,
  decision: Extract<ApprovalDecision, { allowed: false }>,
  classification: CommandClassification | undefined,
): string {
  const message = `Pi Sandbox denied ${subject}: ${decision.reason}`;
  if (
    decision.reason !== "policy_denied" ||
    classification?.commandClass !== "unclassified" ||
    classification.issue === undefined
  )
    return message;
  const classes = COMMAND_CLASSES.map(commandClassLabel).join(" or ");
  return `${message}; not a ${classes} command: ${classification.issue}`;
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
      bashAnalyzer: dependencies.bashAnalyzer,
    };

    const starts: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
    const stops: Array<(event: unknown, ctx: ExtensionContext) => unknown> = [];
    const managedDefinitions = new Map<string, ToolDefinition>();
    const originalDefinitions = new Map<string, ToolDefinition>();
    const desiredActive = new Set<string>();
    const subagentTools = new Map<string, ToolDefinition>();
    let subagents: SubagentController | undefined;
    const environmentPrompt = () =>
      state.executor === undefined ||
      state.config === undefined ||
      state.config.execution.backend === "direct" ||
      state.stopped
        ? undefined
        : toolEnvironmentPrompt({
            home: state.executor.home,
            cwd: dependencies.cwd,
            backend: state.config.execution.backend,
            filesystem: state.config.filesystem,
            ...(dependencies.accountHome === undefined
              ? {}
              : { accountHome: dependencies.accountHome }),
          });
    state.beforeApproval = () => {
      if (subagents !== undefined) closeSubagentPreview(subagents);
    };
    const publish = (definition: ToolDefinition) => {
      originalDefinitions.set(definition.name, definition);
      if (state.preferences?.permitsTool(definition.name) === false)
        definition = { ...definition, exposure: "hidden" };
      managedDefinitions.set(definition.name, definition);
      pi.registerTool(definition);
    };
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
            beforeApproval: state.beforeApproval,
          });
    const childApi = new Proxy(pi, {
      get(target, property): unknown {
        if (property === "on")
          return (name: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
            const staged =
              name === "session_start" ? starts : name === "session_shutdown" ? stops : undefined;
            if (staged === undefined)
              return (target.on as (name: string, handler: unknown) => () => void)(name, handler);
            staged.push(handler);
            return () => {
              const index = staged.indexOf(handler);
              if (index !== -1) staged.splice(index, 1);
            };
          };
        if (property === "registerTool")
          return (definition: ToolDefinition) => {
            if (definition.name !== "codemode") {
              publish(definition);
              return;
            }
            publish({
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
        (dependencies.executionBackend ?? features?.config.execution.backend) === "bubblewrap"
          ? "inside the Bubblewrap sandbox"
          : (dependencies.executionBackend ?? features?.config.execution.backend) === "seatbelt"
            ? "under the macOS Seatbelt filesystem and network policy"
            : (dependencies.executionBackend ?? features?.config.execution.backend) === "direct"
              ? "directly on the host as the current user"
              : "through the managed execution backend",
    })(
      new Proxy(pi, {
        get(target, property): unknown {
          if (property === "registerTool")
            return (definition: ToolDefinition) => sandboxTools.set(definition.name, definition);
          return Reflect.get(target, property);
        },
      }),
    );

    const canSave = () =>
      state.config?.exports.enabled === true &&
      state.config.filesystem.cwdWritable === false &&
      state.config.execution.backend !== "direct" &&
      state.executor !== undefined &&
      !state.stopped;
    const userExports = createUserExportController({
      cwd: dependencies.cwd,
      ...(dependencies.accountHome === undefined ? {} : { accountHome: dependencies.accountHome }),
      getSource: () => dependencies.getExportSource?.(),
      admitted: canSave,
      ...(dependencies.exportAudit === undefined ? {} : { audit: dependencies.exportAudit }),
      beforeCapture: async () => {
        await subagents?.quiesce();
      },
    });
    dependencies.registerBeforeInteractiveQuit?.((ctx, signal) =>
      beforeManagedQuit(ctx, signal, {
        quiesce: async () => {
          await subagents?.quiesce();
        },
        canSave,
        beforeQuit: (context, abortSignal) => userExports.beforeQuit(context, abortSignal),
      }),
    );

    pi.registerCommand("sandbox", {
      description: "Save private sandbox files or show status, mounts, and policy",
      getArgumentCompletions(argumentPrefix) {
        const matches = ["save", ...sandboxCommandArguments(state.config)].filter((argument) =>
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
        if (argumentsList.length === 1 && argumentsList[0] === "save")
          return userExports.run(ctx).then(() => undefined);
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
                  hasSessionGrant: (candidate, scope) => policy.hasSessionGrant(candidate, scope),
                  isToolActive: (candidate) => activeTools.has(candidate),
                  hostToolScopes,
                  ...(state.bashAnalyzer === undefined
                    ? {}
                    : { commandAnalyzer: state.bashAnalyzer }),
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
      try {
        const config = await dependencies.loadConfig();
        state.config = config;
        state.policy = new PolicyEngine(config.tools, mcp?.resolveSubject);
        state.preferences = await createOptionalExtensions({
          pi,
          config,
          agentDir: dependencies.userStateDir,
          args: dependencies.toolArguments ?? [],
          definitions: managedDefinitions,
          originals: originalDefinitions,
          desiredActive,
        });
        registerExtensionPreferencesCommand(pi, state.preferences);
        await dependencies.onSessionStart?.(ctx.sessionManager.getSessionFile());
        await cleanExpiredSubagents({
          userStateDir: dependencies.userStateDir,
          retentionDays: config.sessions.retentionDays,
          parentSessionId: ctx.sessionManager.getSessionId(),
        });
        if (
          hasCommandClassPolicies(config.tools[COMMAND_CLASS_TOOL]) &&
          state.bashAnalyzer === undefined
        )
          throw new Error("Pi Sandbox Bash command analyzer is not initialized");
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
        const managedBoundary = config.execution.backend;
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
              publish(
                config.tools[managedToolPolicySubject(definition.name)]?.audit === true &&
                  state.auditor !== undefined
                  ? state.auditor.wrap(
                      definition,
                      extension === undefined &&
                        !SUBAGENT_TOOL_NAMES.includes(
                          definition.name as (typeof SUBAGENT_TOOL_NAMES)[number],
                        )
                        ? managedBoundary
                        : "host",
                      extension,
                      auditTarget,
                    )
                  : definition,
              );
            };
          },
        });
        const enabled = new Set(
          Object.keys(config.tools)
            .flatMap(policyToolNames)
            .filter(
              (name) =>
                state.policy?.isEnabled(managedToolPolicySubject(name)) === true &&
                isManagedToolSelected(dependencies.toolArguments ?? [], name),
            ),
        );
        for (const definition of sandboxTools.values()) {
          if (enabled.has(definition.name)) registrationApi.registerTool(definition);
        }
        for (const definition of subagentTools.values()) {
          if (enabled.has(definition.name)) registrationApi.registerTool(definition);
        }
        registerManagedTools(registrationApi, state, enabled, dependencies.cwd);
        await registerPiToolExtensions(registrationApi, state, enabled);
        if (config.codemode.enabled && features?.selected("codemode") === true)
          enabled.add("codemode");
        const initialActive = selectManagedActiveTools(
          dependencies.toolArguments ?? [],
          enabled,
          pi.getSettings().defaultTools,
        );
        for (const name of initialActive) desiredActive.add(name);
        pi.setActiveTools(initialActive.filter((name) => state.preferences!.permitsTool(name)));
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
        const children = await Promise.allSettled([subagents?.shutdown() ?? Promise.resolve()]);
        const cleanup = await Promise.allSettled([
          userExports.close(),
          mcp?.close() ?? Promise.resolve(),
          ...stops.map((stop) => Promise.resolve().then(() => stop(event, ctx))),
        ]);
        state.policy?.clearSessionGrants();
        state.executor = undefined;
        const audit = await Promise.allSettled([state.auditor?.end() ?? Promise.resolve()]);
        if ([...children, ...cleanup, ...audit].some((result) => result.status === "rejected"))
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

    if (features?.config.subagents?.enabled === true) {
      if (dependencies.getModelRuntime === undefined)
        throw new Error("Managed subagents require the application model runtime");
      const host = createManagedSubagentHost({
        config: features.config,
        userStateDir: dependencies.userStateDir,
        getModelRuntime: dependencies.getModelRuntime,
        definitions: managedDefinitions,
        getEnvironmentPrompt: environmentPrompt,
        getToolGuidance: (active) =>
          optionalExtensionGuidance(state.config, state.preferences, active),
        isAvailable: () => state.started && !state.stopped && state.executor !== undefined,
        beforeApproval: () => {
          if (subagents !== undefined) closeSubagentPreview(subagents);
        },
        wrapCodeMode: (definition) =>
          state.auditor?.wrap(definition, "host", undefined, undefined, undefined, true) ??
          definition,
      });
      await createSubagentsExtension({
        host,
        onController(controller) {
          subagents = controller;
        },
      })(
        new Proxy(childApi, {
          get(target, property): unknown {
            if (property !== "registerTool") return Reflect.get(target, property);
            return (definition: ToolDefinition) => {
              if (
                !SUBAGENT_TOOL_NAMES.includes(
                  definition.name as (typeof SUBAGENT_TOOL_NAMES)[number],
                )
              )
                throw new Error("Unexpected subagent tool registration");
              subagentTools.set(definition.name, policyWrappedPiTool(definition, state));
            };
          },
        }),
      );
    }

    // Run after MCP's startup hook so autoactivation is reflected in the prompt.
    pi.on("before_agent_start", (event) => {
      const active = new Set(pi.getActiveTools());
      const sections = event.systemPromptOptions.sections;
      delete sections.pi_sandbox_environment;
      const environment = environmentPrompt();
      if (environment !== undefined) sections.pi_sandbox_environment = environment;
      delete sections.pi_sandbox_extension_guidance;
      const guidance = optionalExtensionGuidance(state.config, state.preferences, active);
      if (guidance !== undefined) sections.pi_sandbox_extension_guidance = guidance;
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
