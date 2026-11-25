import {
  createManagedModelRuntimeFactory,
  type ManagedModelRuntimeFactory,
} from "./model-runtime.js";
import {
  createServiceClient,
  formatWorkspaceModes,
  listWorkspaceModes,
  resolveEffectiveAdministrativeConfiguration,
  runAdministrativeCommand,
} from "./administration.js";
import { policyOrigin } from "../config/source.js";
import type { SandboxExportSource } from "../../packages/sandbox-extension/src/runtime/export/contracts.js";
import type { SandboxImportTarget } from "../../packages/sandbox-extension/src/runtime/import/contracts.js";
import { usesSandboxGitDestination } from "../config/git-destination.js";
import { sandboxGitArguments } from "../../packages/git-extension/src/sandbox-clone.js";
import { createExportAudit } from "../audit/exports.js";
import { canonicalizeCommandPathPrepend } from "../../packages/sandbox-extension/src/runtime/command-path.js";

import {
  getAgentDir,
  main as piMain,
  type ModelRuntime,
  type ExtensionFactory,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";

import { buildLayout } from "../build-layout/index.js";
import { DISPLAY_VERSION } from "../version.js";
import { AuditManager, type AuditClient } from "../audit/client.js";
import type { EnvironmentVariables, ManagedEnvironment, SandboxConfig } from "../domain/index.js";
import { createPiSandboxExtension } from "../extension/index.js";
import { resolveMcpServers } from "../mcp/resolve.js";
import { loadMcpPreferences } from "../mcp/preferences.js";
import {
  createHostCommandExecutor,
  type HostCommandExecutor,
} from "../../packages/sandbox-extension/src/runtime/host-command/index.js";
import { managedExtensionCatalog } from "../managed-extensions/registry.js";
import type { ManagedExtensionCatalog } from "../managed-extensions/catalog.js";
import {
  instantiateManagedExtension,
  type FrozenJsonObject,
  type ManagedExtensionInstance,
  type PiToolExtension,
} from "../managed-extensions/sdk.js";
import {
  createBubblewrapExecutor,
  createDirectExecutor,
  createSeatbeltExecutor,
  INTERNAL_EXPORT_READER_ARGUMENT,
  type SandboxExecutor,
} from "../../packages/sandbox-extension/src/runtime/index.js";
import {
  createManagedPiArguments,
  isManagedMcpSelected,
  isManagedToolSelected,
  managedExtensionSelection,
} from "./arguments.js";
import { validateSharedSkillDirectories } from "./skills.js";
import { applyManagedEnvironment } from "./environment.js";
import { assertExecutionPrerequisites } from "./prerequisites.js";
import { createWorkspaceBoundary } from "./workspace.js";
import { createManagedCleanup, createManagedExecutor } from "./managed-executor.js";
import { createConfiguredBashAnalyzer } from "./bash-analysis.js";
import { createAccountIdentityResolver } from "./account-home.js";
import { createMachineIdResolver } from "./machine-id.js";
import type { SandboxArguments } from "./config-arguments.js";
import {
  createSessionMaintenance,
  touchSessionFile,
  type SessionMaintenanceContext,
} from "./session-retention.js";

export interface ManagedMainOptions {
  readonly includeBuiltinTools: false;
  readonly displayVersion: string;
  readonly defaultSkillPaths: readonly string[];
  readonly extensionFactories: Array<{ readonly name: string; readonly factory: ExtensionFactory }>;
  readonly createModelRuntime: ManagedModelRuntimeFactory;
  readonly validateSessionCwd: (cwd: string) => void;
  readonly beforeRun: (context: SessionMaintenanceContext) => Promise<void>;
  readonly beforeInterface: () => Promise<void>;
  readonly beforeExternalMessage: () => Promise<void>;
  readonly beforeInteractiveQuit: (
    ctx: ExtensionCommandContext,
    signal: AbortSignal,
  ) => Promise<boolean>;
}

export type ManagedMain = (args: string[], options: ManagedMainOptions) => Promise<void>;

export function instantiateConfiguredManagedExtensions(
  config: SandboxConfig,
  catalog: ManagedExtensionCatalog = managedExtensionCatalog,
): readonly ManagedExtensionInstance[] {
  return Object.freeze(
    Object.values(config.extensions).flatMap((selected) => {
      const extension = catalog.getExtension(selected.id);
      if (extension === undefined) {
        throw new Error(`configured extension is not compiled in: ${selected.id}`);
      }
      return extension.kind === "managed"
        ? [instantiateManagedExtension(extension, selected.settings as FrozenJsonObject)]
        : [];
    }),
  );
}

export function selectConfiguredPiToolExtensions(
  config: SandboxConfig,
  catalog: ManagedExtensionCatalog = managedExtensionCatalog,
): readonly PiToolExtension[] {
  return Object.freeze(
    Object.values(config.extensions).flatMap((selected) => {
      const extension = catalog.getExtension(selected.id);
      if (extension === undefined) {
        throw new Error(`configured extension is not compiled in: ${selected.id}`);
      }
      return extension.kind === "pi-tool" ? [extension] : [];
    }),
  );
}

function extensionNeedsHostExecutor(
  config: SandboxConfig,
  instance: ManagedExtensionInstance,
): boolean {
  return instance.extension.tools.some((tool) => {
    const mode = config.tools[tool.name]?.mode;
    return mode === "allow" || mode === "ask";
  });
}

async function createProbedExecutor(
  cwd: string,
  config: SandboxConfig,
  environment: EnvironmentVariables,
  ambientEnvironment: NodeJS.ProcessEnv,
  commandPathPrepend: readonly string[],
  onExportSource?: (source: SandboxExportSource) => void,
  onImportTarget?: (target: SandboxImportTarget) => void,
): Promise<SandboxExecutor> {
  let executor: SandboxExecutor;
  const limits =
    config.execution.maximumTimeoutMs === undefined
      ? {}
      : { maximumTimeoutMs: config.execution.maximumTimeoutMs };
  try {
    if (config.execution.backend === "bubblewrap") {
      const bubblewrap = buildLayout.bubblewrap;
      if (bubblewrap === undefined) {
        throw new Error("This distribution does not include a Bubblewrap execution provider");
      }
      executor = await createBubblewrapExecutor({
        cwd,
        limits,
        bubblewrapPath: bubblewrap.path,
        networkMode: config.network.mode,
        cwdWritable: config.filesystem.cwdWritable,
        ...(onExportSource === undefined ? {} : { onExportSource }),
        ...(onImportTarget === undefined ? {} : { onImportTarget }),
        hiddenPaths: config.filesystem.hiddenPaths,
        ...(buildLayout.toolBundle ? { toolBundle: buildLayout.toolBundle } : {}),
        environment,
        commandPathPrepend,
      });
    } else if (config.execution.backend === "seatbelt") {
      if (config.network.mode === "local")
        throw new Error("Seatbelt does not support local networking");
      executor = await createSeatbeltExecutor({
        cwd,
        exportReaderCommand: [process.execPath, INTERNAL_EXPORT_READER_ARGUMENT],
        limits,
        cwdWritable: config.filesystem.cwdWritable,
        ...(onExportSource === undefined ? {} : { onExportSource }),
        deniedPaths: config.filesystem.deniedPaths,
        ...(buildLayout.toolBundle ? { toolBundle: buildLayout.toolBundle } : {}),
        networkMode: config.network.mode,
        environment,
        commandPathPrepend,
      });
    } else if (config.execution.backend === "direct") {
      executor = await createDirectExecutor({
        cwd,
        limits,
        environment,
        commandPathPrepend,
        ambientEnvironment,
        ...(buildLayout.toolBundle ? { toolBundle: buildLayout.toolBundle } : {}),
      });
    } else throw new Error("Unsupported execution backend");
  } catch (error) {
    const detail = actionableErrorMessage(error);
    throw new Error(
      detail === "sandbox_start_failed"
        ? executionStartupMessage(config)
        : `Execution startup failed: ${detail}`,
      { cause: error },
    );
  }
  try {
    await executor.probe().catch((error: unknown) => {
      const detail = actionableErrorMessage(error);
      throw new Error(
        detail === "sandbox_start_failed"
          ? executionStartupMessage(config)
          : `Execution preflight failed: ${detail}`,
        { cause: error },
      );
    });
    if (usesSandboxGitDestination(config.extensions)) {
      const result = await executor.execute({
        argv: sandboxGitArguments(executor.home, ["--version"]),
        timeoutMs: Math.min(10_000, config.execution.maximumTimeoutMs ?? 10_000),
        maxOutputBytes: 4096,
      });
      if (result.exitCode !== 0)
        throw new Error(
          "Sandbox Git requires /usr/bin/env and /usr/bin/git visible inside the sandbox",
        );
    }
    return executor;
  } catch (error) {
    await executor.close().catch(() => undefined);
    throw error;
  }
}

function executionStartupMessage(config: SandboxConfig): string {
  if (config.execution.backend === "bubblewrap")
    return "Bubblewrap could not establish the required sandbox; verify unprivileged user namespaces and Bubblewrap compatibility";
  if (config.execution.backend === "seatbelt")
    return "Seatbelt could not establish the required policy; verify /usr/bin/sandbox-exec and the documented macOS prerequisites";
  return "Direct execution could not establish its bounded command runner; verify the documented host prerequisites";
}

export function actionableErrorMessage(error: unknown): string {
  const pending = [error];
  const seen = new Set<unknown>();
  const messages = new Set<string>();
  // Preserve recovery context and nested failures without unbounded or cyclic
  // error graphs turning a startup diagnostic into an uncontrolled log dump.
  while (pending.length && seen.size < 32) {
    const current = pending.pop();
    if (seen.has(current)) continue;
    seen.add(current);
    const message =
      current instanceof Error ? current.message : typeof current === "string" ? current : "";
    if (message.trim() && message !== "sandbox_start_failed") messages.add(message.slice(0, 1024));
    if (current instanceof Error) {
      const children: unknown[] =
        current instanceof AggregateError ? current.errors.slice(0, 32) : [];
      if (current.cause !== undefined) children.unshift(current.cause);
      for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
    }
  }
  return [...messages].join("; ").slice(0, 4096) || "sandbox_start_failed";
}

function validateExtensionEnvironment(
  environment: ManagedEnvironment,
  instances: readonly ManagedExtensionInstance[],
): void {
  const selected = new Map(instances.map((instance) => [instance.extension.id, instance]));
  for (const [extensionId, variables] of Object.entries(environment.extensions)) {
    const instance = selected.get(extensionId);
    if (instance === undefined) {
      throw new Error(`managed environment for unselected extension: ${extensionId}`);
    }
    const accepted = new Set(instance.hostEnvironment.variables);
    for (const name of Object.keys(variables)) {
      if (!accepted.has(name)) {
        throw new Error(
          `managed environment contains undeclared environment variable for extension ${extensionId}: ${name}`,
        );
      }
    }
  }
}

function extensionHostEnvironment(
  ambient: NodeJS.ProcessEnv,
  piVariables: EnvironmentVariables,
  instances: readonly ManagedExtensionInstance[],
  instance: ManagedExtensionInstance,
  configured: EnvironmentVariables,
  catalog: ManagedExtensionCatalog,
): NodeJS.ProcessEnv {
  const managedNames = new Set<string>([
    ...Object.keys(piVariables),
    ...catalog.extensions.flatMap((extension) => extension.hostEnvironment.variables),
    ...instances.flatMap((candidate) => candidate.hostEnvironment.variables),
  ]);
  const output: NodeJS.ProcessEnv = Object.fromEntries(
    Object.entries(ambient).filter(
      (entry): entry is [string, string] => entry[1] !== undefined && !managedNames.has(entry[0]),
    ),
  );
  for (const name of instance.hostEnvironment.variables) {
    const value = ambient[name];
    if (value !== undefined) output[name] = value;
  }
  for (const name of instance.hostEnvironment.removeInherited ?? []) delete output[name];
  for (const prefix of instance.hostEnvironment.removeInheritedPrefixes ?? []) {
    for (const name of Object.keys(output)) {
      if (name.startsWith(prefix)) delete output[name];
    }
  }
  Object.assign(output, configured);
  Object.assign(output, instance.hostEnvironment.fixed ?? {});
  return Object.freeze(output);
}

/** Build one isolated host environment for each selected managed extension. */
export function resolveManagedExtensionHostEnvironments(
  ambient: NodeJS.ProcessEnv,
  environment: ManagedEnvironment,
  instances: readonly ManagedExtensionInstance[],
  catalog: ManagedExtensionCatalog = managedExtensionCatalog,
): Readonly<Record<string, NodeJS.ProcessEnv>> {
  validateExtensionEnvironment(environment, instances);
  const resolved: Record<string, NodeJS.ProcessEnv> = {};
  for (const instance of instances) {
    resolved[instance.extension.id] = extensionHostEnvironment(
      ambient,
      environment.pi,
      instances,
      instance,
      environment.extensions[instance.extension.id] ?? Object.freeze({}),
      catalog,
    );
  }
  return Object.freeze(resolved);
}

export async function runPiSandbox({
  piArgs: args,
  configPath,
  workspaceMode,
  listWorkspaceModes: listModes,
}: SandboxArguments): Promise<void> {
  // Supervisors probe the worker before selecting its workspace. Metadata needs no authority.
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${DISPLAY_VERSION}\n`);
    return;
  }
  if (await runAdministrativeCommand(args, configPath)) return;
  const ambientHostEnvironment = Object.freeze({ ...process.env });
  const getAccountIdentity = createAccountIdentityResolver();
  const getMachineId = createMachineIdResolver();
  const source = buildLayout.configuration;
  const endpoint = source.source === "service" ? source.endpoint : source.auditEndpoint;
  const service =
    endpoint === undefined
      ? undefined
      : createServiceClient(endpoint, getAccountIdentity, getMachineId);
  const sourceOptions = {
    ...(configPath === undefined ? {} : { configPath }),
    ...(service === undefined ? {} : { service }),
    getAccountIdentity,
    getMachineId,
    ...(workspaceMode === undefined ? {} : { workspaceMode }),
  };
  if (listModes === true) {
    process.stdout.write(formatWorkspaceModes(await listWorkspaceModes(sourceOptions)));
    return;
  }
  const { config, models, provenance, accountHome, workspaceSelection } =
    await resolveEffectiveAdministrativeConfiguration(sourceOptions);
  const identityEnvironment = config.environment;
  const modelFactory = createManagedModelRuntimeFactory({
    models,
    environment: identityEnvironment.pi,
    personalProviders: config.modelAuth.personalProviders,
  });
  const optionalIds = new Set([
    "subagents",
    ...Object.values(config.extensions).map((extension) => extension.id),
  ]);
  for (const [id, enabled] of managedExtensionSelection(args).overrides) {
    if (!optionalIds.has(id))
      throw new Error(
        `Unknown optional extension ${JSON.stringify(id)} for --${enabled ? "enable" : "disable"}-extension. Available IDs: ${[...optionalIds].sort().join(", ")}`,
      );
  }
  await validateSharedSkillDirectories(config.skills.directories);
  const { cwd, validateSessionCwd } = createWorkspaceBoundary(process.cwd());
  const managedExtensions = instantiateConfiguredManagedExtensions(config);
  const piToolExtensions = selectConfiguredPiToolExtensions(config);
  const extensionEnvironments = resolveManagedExtensionHostEnvironments(
    ambientHostEnvironment,
    identityEnvironment,
    managedExtensions,
  );
  const managedExecutables = managedExtensions.flatMap(
    (instance) => instance.requiredHostExecutables,
  );
  await assertExecutionPrerequisites(config.execution.backend, buildLayout, managedExecutables);
  const commandPathPrepend = await canonicalizeCommandPathPrepend(
    config.execution.commandPathPrepend,
    {
      backend: config.execution.backend,
      cwd,
      cwdWritable: config.filesystem.cwdWritable,
      hiddenPaths: config.filesystem.hiddenPaths,
      deniedPaths: config.filesystem.deniedPaths,
    },
  );
  const bashAnalyzer = createConfiguredBashAnalyzer({
    config,
    cwd,
    sandboxEnvironment: identityEnvironment.sandbox,
    ambientEnvironment: ambientHostEnvironment,
    commandPathPrepend,
    ...(buildLayout.toolBundle ? { toolBundle: buildLayout.toolBundle } : {}),
  });
  let exportSource: SandboxExportSource | undefined;
  let importTarget: SandboxImportTarget | undefined;
  const executor = createManagedExecutor({
    cwd,
    create: () =>
      createProbedExecutor(
        cwd,
        config,
        identityEnvironment.sandbox,
        ambientHostEnvironment,
        commandPathPrepend,
        config.exports.enabled
          ? (source) => {
              exportSource = source;
            }
          : undefined,
        usesSandboxGitDestination(config.extensions)
          ? (target) => {
              importTarget = target;
            }
          : undefined,
      ),
  });
  const hostExecutors: Record<string, HostCommandExecutor> = {};
  let auditClient: AuditClient | undefined;
  const closeRuntime = createManagedCleanup(() => [
    executor,
    ...Object.values(hostExecutors),
    ...(auditClient === undefined ? [] : [auditClient]),
  ]);
  try {
    if (config.audit.enabled) {
      if (service === undefined) throw new Error("Auditing requires a compiled service endpoint");
      auditClient = new AuditManager(service, cwd, policyOrigin(provenance));
    }
    for (const instance of managedExtensions) {
      if (!extensionNeedsHostExecutor(config, instance)) continue;
      hostExecutors[instance.extension.id] = createHostCommandExecutor({
        cwd,
        environment: extensionEnvironments[instance.extension.id]!,
      });
    }
    const lease = applyManagedEnvironment(identityEnvironment.pi);
    try {
      const userStateDir = getAgentDir();
      const servers = isManagedMcpSelected(args)
        ? await resolveMcpServers(
            config.mcp,
            Object.freeze({ ...ambientHostEnvironment, ...identityEnvironment.pi }),
            getAccountIdentity,
            undefined,
            getMachineId,
          )
        : [];
      const mcpPreferences = servers.some((server) => server.status === "ready")
        ? await loadMcpPreferences(userStateDir)
        : undefined;
      let beforeInteractiveQuit: ManagedMainOptions["beforeInteractiveQuit"] = () =>
        Promise.resolve(true);
      let activeModelRuntime: ModelRuntime | undefined;
      const extension = createPiSandboxExtension({
        features: {
          config,
          servers,
          ...(mcpPreferences === undefined ? {} : { mcpPreferences }),
          selected: (name) => isManagedToolSelected(args, name),
        },
        cwd,
        provenance,
        workspaceSelection,
        userStateDir,
        getModelRuntime: () => {
          if (activeModelRuntime === undefined)
            throw new Error("Managed model runtime is unavailable");
          return activeModelRuntime;
        },
        ...(config.sessions.retentionDays === 0 ? {} : { onSessionStart: touchSessionFile }),
        onProcessShutdown: closeRuntime,
        registerBeforeInteractiveQuit: (handler) => {
          beforeInteractiveQuit = handler;
        },
        toolArguments: args,
        loadConfig: () => Promise.resolve(config),
        executor,
        getExportSource: () => exportSource,
        getImportTarget: () => importTarget,
        ...(auditClient === undefined
          ? {}
          : { createExportAudit: (id: string) => createExportAudit(auditClient!, id) }),
        ...(accountHome === undefined ? {} : { accountHome }),
        ...(bashAnalyzer === undefined ? {} : { bashAnalyzer }),
        ...(auditClient === undefined ? {} : { auditClient }),
        managedExtensions,
        piToolExtensions,
        hostExecutors: Object.freeze(hostExecutors),
      });
      const managedMain = piMain as unknown as ManagedMain;
      if (args[0] === "--help" || args[0] === "-h") {
        process.stdout.write(
          `Pi Sandbox: --workspace-mode NAME selects an allowed workspace mode before Pi arguments (selected: ${workspaceSelection.name}).\nWithout a selector, the configured account default is used. Use --list-workspace-modes for available choices and descriptions. File exports are available only in the terminal UI when enabled by policy.\n\n`,
        );
        process.stdout.write(
          "Pi Sandbox: --disable-extension ID / --enable-extension ID override optional extension preferences for this process.\nUse /extensions to change saved preferences.\n\n",
        );
      }
      if (
        buildLayout.configuration.source === "local" &&
        buildLayout.configuration.allowConfigOverride &&
        (args[0] === "--help" || args[0] === "-h")
      ) {
        process.stdout.write(
          "Pi Sandbox: --config FILE selects a TOML policy before Pi arguments.\n\n",
        );
      }
      await managedMain(createManagedPiArguments(args), {
        includeBuiltinTools: false,
        displayVersion: DISPLAY_VERSION,
        defaultSkillPaths: config.skills.directories,
        extensionFactories: [{ name: "pi-sandbox", factory: extension }],
        createModelRuntime: async (options = {}) => {
          activeModelRuntime = await modelFactory(options);
          return activeModelRuntime;
        },
        validateSessionCwd,
        beforeRun: createSessionMaintenance({
          agentDir: userStateDir,
          retentionDays: config.sessions.retentionDays,
          reportProgress: () => {
            process.stderr.write("Checking for old sessions…\n");
          },
        }),
        beforeInterface: () => executor.probe(),
        beforeExternalMessage: async () => {
          await auditClient?.checkpoint();
        },
        beforeInteractiveQuit: (ctx, signal) => beforeInteractiveQuit(ctx, signal),
      });
    } finally {
      lease.restore();
    }
  } finally {
    await closeRuntime();
  }
}
