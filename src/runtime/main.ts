import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  main as piMain,
  ModelRuntime,
  type CreateModelRuntimeOptions,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import { buildLayout } from "../build-layout/index.js";
import { DISPLAY_VERSION } from "../version.js";
import { connectAuditClient, type AuditClient } from "../audit/client.js";
import { loadConfig } from "../config/index.js";
import type {
  AccountIdentity,
  AuthoredPiEnvironmentValue,
  EnvironmentVariables,
  ManagedEnvironment,
  SandboxConfig,
} from "../domain/index.js";
import { expandManagedHomePaths, overlayManagedEnvironment } from "../domain/index.js";
import { createPiSandboxExtension } from "../extension/index.js";
import { resolveMcpServers } from "../mcp/resolve.js";
import { loadMcpPreferences } from "../mcp/preferences.js";
import {
  createHostCommandExecutor,
  type HostCommandExecutor,
} from "../../packages/sandbox-extension/src/runtime/host-command/index.js";
import {
  applyIdentityOverrides,
  type BrokerIdentityResolver,
  configureManagedIdentity,
} from "../identity/index.js";
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
  type SandboxExecutor,
} from "../../packages/sandbox-extension/src/runtime/index.js";
import {
  createManagedPiArguments,
  isManagedMcpSelected,
  isManagedToolSelected,
} from "./arguments.js";
import { applyManagedEnvironment } from "./environment.js";
import { resolveEnvironmentFiles } from "./environment-files.js";
import { assertExecutionPrerequisites } from "./prerequisites.js";
import { createWorkspaceBoundary } from "./workspace.js";
import { createManagedCleanup, createManagedExecutor } from "./managed-executor.js";
import { createConfiguredBashAnalyzer } from "./bash-analysis.js";
import {
  createAccountIdentityResolver,
  readAccountIdentity,
  resolvePromptAccountHome,
} from "./account-home.js";
import { createMachineIdResolver, readMachineId } from "./machine-id.js";
import type { SandboxArguments } from "./config-arguments.js";
import {
  createSessionMaintenance,
  touchSessionFile,
  type SessionMaintenanceContext,
} from "./session-retention.js";

export const SYSTEM_CONFIG_PATH = buildLayout.configPath;

export interface ManagedModelRuntimeOptions extends CreateModelRuntimeOptions {
  readonly includeBuiltinCatalog: false;
}

export type ManagedModelRuntimeFactory = (
  options?: CreateModelRuntimeOptions,
) => Promise<ModelRuntime>;

export interface ManagedMainOptions {
  readonly includeBuiltinTools: false;
  readonly displayVersion: string;
  readonly extensionFactories: Array<{ readonly name: string; readonly factory: ExtensionFactory }>;
  readonly createModelRuntime: ManagedModelRuntimeFactory;
  readonly validateSessionCwd: (cwd: string) => void;
  readonly beforeRun: (context: SessionMaintenanceContext) => Promise<void>;
  readonly beforeInterface: () => Promise<void>;
}

export type ManagedMain = (args: string[], options: ManagedMainOptions) => Promise<void>;

function pathUnderRoot(root: string, absolutePath: string): string {
  if (!isAbsolute(root)) throw new Error("validation root must be absolute");
  if (!isAbsolute(absolutePath)) throw new Error("administrative path must be absolute");
  const normalizedRoot = resolve(root);
  return normalizedRoot === "/" ? absolutePath : join(normalizedRoot, absolutePath.slice(1));
}

async function createConfiguredModelRuntime(
  modelsPath: string,
  options: CreateModelRuntimeOptions = {},
): Promise<ModelRuntime> {
  const managedOptions: ManagedModelRuntimeOptions = {
    ...options,
    modelsPath,
    modelsStore: new InMemoryModelsStore(),
    allowModelNetwork: false,
    includeBuiltinCatalog: false,
  };
  const runtime = await ModelRuntime.create(managedOptions);
  const error = runtime.getError();
  if (error !== undefined) throw new Error(error);
  return runtime;
}

export function createManagedModelRuntimeFactory(modelsPath: string): ManagedModelRuntimeFactory {
  return async (options = {}) => createConfiguredModelRuntime(modelsPath, options);
}

async function loadAdministrativeConfig(
  root: string,
  configPath: string,
): Promise<SandboxConfig<AuthoredPiEnvironmentValue>> {
  return loadConfig(pathUnderRoot(root, configPath), managedExtensionCatalog);
}

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

async function readAdministrativeModels(
  config: Pick<SandboxConfig, "modelsFile">,
  root = "/",
): Promise<string> {
  const modelsPath = pathUnderRoot(root, config.modelsFile);
  await readFile(modelsPath, "utf8");
  return modelsPath;
}

export async function validateAdministrativeConfiguration(
  root = "/",
  configPath = SYSTEM_CONFIG_PATH,
): Promise<SandboxConfig<AuthoredPiEnvironmentValue>> {
  const config = await loadAdministrativeConfig(root, configPath);
  assertExecutionPlatform(config);
  const modelsPath = await readAdministrativeModels(config, root);
  await createConfiguredModelRuntime(modelsPath, { refreshOnCreate: false });
  return config;
}

export async function resolveEffectiveAdministrativeConfiguration(
  root = "/",
  environment: NodeJS.ProcessEnv = process.env,
  resolveIdentity?: BrokerIdentityResolver,
  configPath = SYSTEM_CONFIG_PATH,
  getAccountIdentity: () => AccountIdentity = readAccountIdentity,
  getMachineId: () => string = readMachineId,
): Promise<{
  readonly config: SandboxConfig;
  readonly modelsPath: string;
  readonly identityEnvironment: ManagedEnvironment;
  readonly accountHome?: string;
}> {
  const baseConfig = await loadAdministrativeConfig(root, configPath);
  assertExecutionPlatform(baseConfig);
  const identity = await configureManagedIdentity(baseConfig.identity, resolveIdentity);
  const combinedEnvironment = overlayManagedEnvironment(
    baseConfig.environment,
    identity.environment,
  );
  const overridden = applyIdentityOverrides(baseConfig, identity.overrides);
  assertExecutionPlatform(overridden);
  const account = createAccountIdentityResolver(getAccountIdentity);
  // Resolve only effective configured values, before any managed HOME takes
  // effect. The account lookup must not trust the process's HOME value.
  const expanded = expandManagedHomePaths(
    overridden.filesystem,
    await resolveEnvironmentFiles(combinedEnvironment),
    account,
    createMachineIdResolver(getMachineId),
  );
  const effectiveEnvironment = expanded.environment;
  const config = Object.freeze({
    ...overridden,
    filesystem: expanded.filesystem,
    environment: effectiveEnvironment,
  });
  const accountHome =
    config.execution.backend === "direct" ? undefined : await resolvePromptAccountHome(account);
  const lease = applyManagedEnvironment(effectiveEnvironment.pi, environment);
  try {
    const modelsPath = await readAdministrativeModels(config, root);
    await createConfiguredModelRuntime(modelsPath, { refreshOnCreate: false });
    return {
      config,
      modelsPath,
      identityEnvironment: effectiveEnvironment,
      ...(accountHome === undefined ? {} : { accountHome }),
    };
  } finally {
    lease.restore();
  }
}

async function createProbedExecutor(
  cwd: string,
  config: SandboxConfig,
  environment: EnvironmentVariables,
  ambientEnvironment: NodeJS.ProcessEnv,
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
        hiddenPaths: config.filesystem.hiddenPaths,
        ...(buildLayout.toolBundle ? { toolBundle: buildLayout.toolBundle } : {}),
        environment,
      });
    } else if (config.execution.backend === "seatbelt") {
      if (config.network.mode === "local")
        throw new Error("Seatbelt does not support local networking");
      executor = await createSeatbeltExecutor({
        cwd,
        limits,
        cwdWritable: config.filesystem.cwdWritable,
        deniedPaths: config.filesystem.deniedPaths,
        ...(buildLayout.toolBundle ? { toolBundle: buildLayout.toolBundle } : {}),
        networkMode: config.network.mode,
        environment,
      });
    } else if (config.execution.backend === "direct") {
      executor = await createDirectExecutor({
        cwd,
        limits,
        environment,
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

export function assertExecutionPlatform(
  config: Pick<SandboxConfig, "execution" | "network" | "filesystem" | "identity" | "audit">,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`Unsupported operating system: ${platform}`);
  }
  if (config.execution.backend === "bubblewrap" && platform !== "linux") {
    throw new Error("Bubblewrap execution is supported only on Linux");
  }
  if (config.execution.backend === "seatbelt") {
    if (platform !== "darwin") throw new Error("Seatbelt execution is supported only on macOS");
    if (config.network.mode === "local")
      throw new Error("Seatbelt execution requires network.mode = none or host");
    if (config.filesystem.hiddenPaths.length > 0)
      throw new Error("Seatbelt execution requires filesystem.hidden_paths = []");
  } else if (config.filesystem.deniedPaths.length > 0) {
    throw new Error("filesystem.denied_paths requires Seatbelt execution");
  }
  if (config.execution.backend === "direct" && config.network.mode !== "host") {
    throw new Error("Direct execution requires network.mode = host");
  }
  if (config.execution.backend === "direct" && !config.filesystem.cwdWritable) {
    throw new Error("Direct execution requires filesystem.cwd_writable = true");
  }
  if (config.execution.backend === "direct" && config.filesystem.hiddenPaths.length > 0) {
    throw new Error("Direct execution requires filesystem.hidden_paths = []");
  }
  if (platform === "darwin" && config.identity.mode !== "disabled") {
    throw new Error(
      "The identity broker is supported only on Linux; macOS requires identity.mode = disabled",
    );
  }
  if (platform === "darwin" && config.audit.enabled) {
    throw new Error(
      "Tool logging is supported only on Linux; macOS requires audit.enabled = false",
    );
  }
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

function parseValidationRoot(args: readonly string[]): string | undefined {
  if (args[0] !== "--validate-installation") return undefined;
  if (args.length === 1) return "/";
  if (args.length === 3 && args[1] === "--root" && args[2] !== undefined) return args[2];
  throw new Error("usage: pi-sandbox --validate-installation [--root DESTDIR]");
}

function parseBackendQueryRoot(args: readonly string[]): string | undefined {
  if (args[0] !== "--print-execution-backend") return undefined;
  if (args.length === 1) return "/";
  if (args.length === 3 && args[1] === "--root" && args[2] !== undefined) return args[2];
  throw new Error("usage: pi-sandbox --print-execution-backend [--root DESTDIR]");
}

export async function runPiSandbox({ piArgs: args, configPath }: SandboxArguments): Promise<void> {
  // Supervisors probe the worker before selecting its workspace. Metadata needs no authority.
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`${DISPLAY_VERSION}\n`);
    return;
  }
  const validationRoot = parseValidationRoot(args);
  if (validationRoot !== undefined) {
    await validateAdministrativeConfiguration(validationRoot, configPath);
    return;
  }
  const backendQueryRoot = parseBackendQueryRoot(args);
  if (backendQueryRoot !== undefined) {
    const config = await validateAdministrativeConfiguration(backendQueryRoot, configPath);
    process.stdout.write(`${config.execution.backend}\n`);
    return;
  }

  const ambientHostEnvironment = { ...process.env };
  const getAccountIdentity = createAccountIdentityResolver();
  const getMachineId = createMachineIdResolver();
  const { config, modelsPath, identityEnvironment, accountHome } =
    await resolveEffectiveAdministrativeConfiguration(
      "/",
      process.env,
      undefined,
      configPath,
      getAccountIdentity,
      getMachineId,
    );
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
  const bashAnalyzer = createConfiguredBashAnalyzer({
    config,
    cwd,
    sandboxEnvironment: identityEnvironment.sandbox,
    ambientEnvironment: ambientHostEnvironment,
    ...(buildLayout.toolBundle ? { toolBundle: buildLayout.toolBundle } : {}),
  });
  const executor = createManagedExecutor({
    cwd,
    create: () =>
      createProbedExecutor(cwd, config, identityEnvironment.sandbox, ambientHostEnvironment),
  });
  const hostExecutors: Record<string, HostCommandExecutor> = {};
  let auditClient: AuditClient | undefined;
  const closeRuntime = createManagedCleanup(() => [
    executor,
    ...Object.values(hostExecutors),
    ...(auditClient === undefined ? [] : [auditClient]),
  ]);
  try {
    if (config.audit.enabled) auditClient = await connectAuditClient(buildLayout.auditSocketPath);
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
            process.env,
            getAccountIdentity,
            undefined,
            getMachineId,
          )
        : [];
      const mcpPreferences = servers.some((server) => server.status === "ready")
        ? await loadMcpPreferences(userStateDir)
        : undefined;
      const extension = createPiSandboxExtension({
        features: {
          config,
          servers,
          ...(mcpPreferences === undefined ? {} : { mcpPreferences }),
          selected: (name) => isManagedToolSelected(args, name),
        },
        cwd,
        configPath,
        userStateDir,
        ...(config.sessions.retentionDays === 0 ? {} : { onSessionStart: touchSessionFile }),
        onProcessShutdown: closeRuntime,
        toolArguments: args,
        loadConfig: () => Promise.resolve(config),
        executor,
        ...(accountHome === undefined ? {} : { accountHome }),
        ...(bashAnalyzer === undefined ? {} : { bashAnalyzer }),
        ...(auditClient === undefined ? {} : { auditClient }),
        managedExtensions,
        piToolExtensions,
        hostExecutors: Object.freeze(hostExecutors),
      });
      const managedMain = piMain as unknown as ManagedMain;
      if (buildLayout.allowConfigOverride && (args[0] === "--help" || args[0] === "-h")) {
        process.stdout.write(
          "Pi Sandbox: --config FILE selects a TOML policy before Pi arguments.\n\n",
        );
      }
      await managedMain(createManagedPiArguments(args), {
        includeBuiltinTools: false,
        displayVersion: DISPLAY_VERSION,
        extensionFactories: [{ name: "pi-sandbox", factory: extension }],
        createModelRuntime: createManagedModelRuntimeFactory(modelsPath),
        validateSessionCwd,
        beforeRun: createSessionMaintenance({
          agentDir: userStateDir,
          retentionDays: config.sessions.retentionDays,
          reportProgress: () => {
            process.stderr.write("Checking for old sessions…\n");
          },
        }),
        beforeInterface: () => executor.probe(),
      });
    } finally {
      lease.restore();
    }
  } finally {
    await closeRuntime();
  }
}
