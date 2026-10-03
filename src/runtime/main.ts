import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  getAgentDir,
  main as piMain,
  ModelRuntime,
  VERSION,
  type CreateModelRuntimeOptions,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";

import { buildLayout } from "../build-layout/index.js";
import { connectAuditClient, type AuditClient } from "../audit/client.js";
import { loadConfig } from "../config/index.js";
import type { EnvironmentVariables, ManagedEnvironment, SandboxConfig } from "../domain/index.js";
import { overlayManagedEnvironment } from "../domain/index.js";
import { createPiSandboxExtension } from "../extension/index.js";
import { createHostCommandExecutor, type HostCommandExecutor } from "../host/index.js";
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
  type SandboxExecutor,
} from "../sandbox/index.js";
import { createManagedPiArguments, selectManagedActiveTools } from "./arguments.js";
import { applyManagedEnvironment } from "./environment.js";
import { assertHostPrerequisites } from "./prerequisites.js";
import { createWorkspaceBoundary } from "./workspace.js";
import type { SandboxArguments } from "./config-arguments.js";

export const SYSTEM_CONFIG_PATH = buildLayout.configPath;

interface ManagedModelRuntimeOptions extends CreateModelRuntimeOptions {
  readonly includeBuiltinCatalog: false;
}

type ManagedModelRuntimeFactory = (options?: CreateModelRuntimeOptions) => Promise<ModelRuntime>;

interface ManagedMainOptions {
  readonly extensionFactories: Array<{ readonly name: string; readonly factory: ExtensionFactory }>;
  readonly createModelRuntime: ManagedModelRuntimeFactory;
  readonly validateSessionCwd: (cwd: string) => void;
}

type ManagedMain = (args: string[], options: ManagedMainOptions) => Promise<void>;

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

async function loadAdministrativeConfig(root: string, configPath: string): Promise<SandboxConfig> {
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

async function readAdministrativeModels(config: SandboxConfig, root = "/"): Promise<string> {
  const modelsPath = pathUnderRoot(root, config.modelsFile);
  await readFile(modelsPath, "utf8");
  return modelsPath;
}

export async function validateAdministrativeConfiguration(
  root = "/",
  configPath = SYSTEM_CONFIG_PATH,
): Promise<SandboxConfig> {
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
): Promise<{
  readonly config: SandboxConfig;
  readonly modelsPath: string;
  readonly identityEnvironment: ManagedEnvironment;
}> {
  const baseConfig = await loadAdministrativeConfig(root, configPath);
  assertExecutionPlatform(baseConfig);
  const identity = await configureManagedIdentity(baseConfig.identity, resolveIdentity);
  const effectiveEnvironment = overlayManagedEnvironment(
    baseConfig.environment,
    identity.environment,
  );
  const lease = applyManagedEnvironment(effectiveEnvironment.pi, environment);
  try {
    const config = applyIdentityOverrides(baseConfig, identity.overrides);
    assertExecutionPlatform(config);
    const modelsPath = await readAdministrativeModels(config, root);
    await createConfiguredModelRuntime(modelsPath, { refreshOnCreate: false });
    return { config, modelsPath, identityEnvironment: effectiveEnvironment };
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
  try {
    if (config.execution.backend === "bubblewrap") {
      const bubblewrap = buildLayout.bubblewrap;
      if (bubblewrap === undefined) {
        throw new Error("This distribution does not include a Bubblewrap execution provider");
      }
      executor = await createBubblewrapExecutor({
        cwd,
        bubblewrapPath: bubblewrap.path,
        networkMode: config.network.mode,
        cwdWritable: config.filesystem.cwdWritable,
        environment,
      });
    } else {
      executor = await createDirectExecutor({ cwd, environment, ambientEnvironment });
    }
  } catch (error) {
    const detail = actionableErrorMessage(error);
    throw new Error(
      detail === "sandbox_start_failed"
        ? config.execution.backend === "bubblewrap"
          ? "Bubblewrap could not establish the required sandbox; verify unprivileged user namespaces and Bubblewrap compatibility"
          : "Direct execution could not establish its bounded command runner; verify the documented host prerequisites"
        : `Execution startup failed: ${detail}`,
      { cause: error },
    );
  }
  try {
    await executor.probe().catch((error: unknown) => {
      const detail = actionableErrorMessage(error);
      throw new Error(
        detail === "sandbox_start_failed"
          ? config.execution.backend === "bubblewrap"
            ? "Bubblewrap could not establish the required sandbox; verify unprivileged user namespaces and Bubblewrap compatibility"
            : "Direct execution could not establish its bounded command runner; verify the documented host prerequisites"
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

export function assertExecutionPlatform(
  config: SandboxConfig,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "linux" && platform !== "darwin") {
    throw new Error(`Unsupported operating system: ${platform}`);
  }
  if (config.execution.backend === "bubblewrap" && platform !== "linux") {
    throw new Error("Bubblewrap execution is supported only on Linux");
  }
  if (config.execution.backend === "direct" && config.network.mode !== "host") {
    throw new Error("Direct execution requires network.mode = host");
  }
  if (config.execution.backend === "direct" && !config.filesystem.cwdWritable) {
    throw new Error("Direct execution requires filesystem.cwd_writable = true");
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

function actionableErrorMessage(error: unknown): string {
  let current = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    if (current.message.length > 0 && current.message !== "sandbox_start_failed") {
      return current.message;
    }
    current = current.cause;
  }
  return "sandbox_start_failed";
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
    process.stdout.write(`${VERSION}\n`);
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
  const { config, modelsPath, identityEnvironment } =
    await resolveEffectiveAdministrativeConfiguration("/", process.env, undefined, configPath);
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
  await assertHostPrerequisites({
    ...(config.execution.backend === "direct" ? { fixedExecutables: [] } : {}),
    additionalFixedExecutables: [
      ...managedExecutables,
      ...(config.execution.backend === "bubblewrap" && buildLayout.bubblewrap !== undefined
        ? [buildLayout.bubblewrap.path]
        : []),
    ],
  });
  const executor = await createProbedExecutor(
    cwd,
    config,
    identityEnvironment.sandbox,
    ambientHostEnvironment,
  );
  const hostExecutors: Record<string, HostCommandExecutor> = {};
  let auditClient: AuditClient | undefined;
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
      const enabledTools = new Set(
        Object.keys(config.tools).filter((toolName) => config.tools[toolName]?.mode !== "disabled"),
      );
      const extension = createPiSandboxExtension({
        cwd,
        configPath,
        userStateDir: getAgentDir(),
        activeTools: selectManagedActiveTools(args, enabledTools),
        loadConfig: () => Promise.resolve(config),
        executor,
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
        extensionFactories: [{ name: "pi-sandbox", factory: extension }],
        createModelRuntime: createManagedModelRuntimeFactory(modelsPath),
        validateSessionCwd,
      });
    } finally {
      lease.restore();
    }
  } finally {
    await Promise.all([
      executor.close(),
      ...Object.values(hostExecutors).map((host) => host.close()),
      ...(auditClient === undefined ? [] : [auditClient.close()]),
    ]);
  }
}
