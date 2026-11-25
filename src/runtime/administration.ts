import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join } from "node:path";
import { stat } from "node:fs/promises";
import { buildLayout, type CompiledLayout } from "../build-layout/index.js";
import { DISPLAY_VERSION } from "../version.js";
import {
  loadConfig,
  resolveWorkspaceAccess,
  resolveWorkspaceSelection,
  type WorkspaceAccess,
} from "../config/index.js";
import { applyAccountOverrides } from "../config/account-overrides.js";
import { validateExtensionEnvironment } from "../config/parse.js";
import {
  assertLocalAuditEndpoint,
  inspectAdministrativePolicy,
  loadAdministrativeSnapshot,
  readModelConfiguration,
  underRoot,
  validateBootstrapResult,
  type AdministrativeSnapshot,
  type AdministrativeSourceOptions,
} from "../config/source.js";
import {
  expandManagedHomePaths,
  type AccountIdentity,
  type AuthoredSandboxConfig,
  type AuthoredPiEnvironmentValue,
} from "../domain/index.js";
import { managedExtensionCatalog } from "../managed-extensions/registry.js";
import { ServiceClient } from "../service/client.js";
import type { ConfigurationSource, ServiceEndpoint } from "../service/endpoint.js";
import { isRecord, parseStrictJson } from "../service/json.js";
import { readBoundedUtf8File } from "../service/files.js";
import {
  parseServiceResponse,
  type ClientMetadata,
  type ServiceTransport,
} from "../service/protocol.js";
import {
  createAccountIdentityResolver,
  readAccountIdentity,
  resolvePromptAccountHome,
} from "./account-home.js";
import { createMachineIdResolver, readMachineId } from "./machine-id.js";
import { assertExecutionPlatform } from "./execution-platform.js";
import {
  createManagedModelRuntimeFactory,
  validateManagedModelConfiguration,
} from "./model-runtime.js";
import { assertExecutionPrerequisites } from "./prerequisites.js";
import { validateCandidateSkillDirectories } from "./skills.js";

export interface AdministrativeOptions {
  readonly configuration?: ConfigurationSource;
  readonly configPath?: string;
  readonly service?: ServiceTransport;
  readonly getAccountIdentity?: () => AccountIdentity;
  readonly getMachineId?: () => string;
  readonly workspaceMode?: string;
}

function clientMetadata(): ClientMetadata {
  if (
    (process.platform !== "linux" && process.platform !== "darwin") ||
    (process.arch !== "x64" && process.arch !== "arm64")
  )
    throw new Error("Unsupported client platform");
  return {
    platform: process.platform,
    architecture: process.arch,
    application_version: DISPLAY_VERSION,
    build_id: DISPLAY_VERSION,
  };
}
export function createServiceClient(
  endpoint: ServiceEndpoint,
  account: () => AccountIdentity,
  machine: () => string,
): ServiceClient {
  return new ServiceClient(endpoint, {
    identity: () => ({
      username: account().username,
      ...(endpoint.transport === "https" && endpoint.sendMachineId
        ? { machine_id: machine() }
        : {}),
    }),
  });
}
function validatePolicy(policy: AuthoredSandboxConfig<AuthoredPiEnvironmentValue>): void {
  for (const mode of Object.values(policy.workspace.modes)) assertExecutionPlatform(mode.config);
}
function sourceOptions(options: AdministrativeOptions): AdministrativeSourceOptions {
  const configuration = options.configuration ?? buildLayout.configuration;
  const service =
    options.service ??
    (configuration.source === "service"
      ? createServiceClient(
          configuration.endpoint,
          createAccountIdentityResolver(options.getAccountIdentity),
          createMachineIdResolver(options.getMachineId),
        )
      : undefined);
  return {
    catalog: managedExtensionCatalog,
    client: clientMetadata(),
    validatePolicy,
    ...(options.configPath === undefined ? {} : { configPath: options.configPath }),
    ...(service === undefined ? {} : { service }),
  };
}
export async function listWorkspaceModes(
  options: AdministrativeOptions = {},
): Promise<WorkspaceAccess> {
  const { policy, workspaceOverrides } = await inspectAdministrativePolicy(
    options.configuration ?? buildLayout.configuration,
    sourceOptions(options),
  );
  return resolveWorkspaceAccess(policy, workspaceOverrides);
}
export function formatWorkspaceModes(access: WorkspaceAccess): string {
  return (
    access.allowed
      .map(
        (mode) =>
          `${mode.name}${mode.name === access.default ? " (default)" : ""}${mode.description === undefined ? "" : ` — ${mode.description}`}`,
      )
      .join("\n") + "\n"
  );
}
function selectSnapshot(snapshot: Omit<AdministrativeSnapshot, "provenance">, requested?: string) {
  validatePolicy(snapshot.policy);
  const { config: base, selection } = resolveWorkspaceSelection(
    snapshot.policy,
    snapshot.overrides.workspace,
    requested,
  );
  const config = applyAccountOverrides(base, snapshot.overrides);
  assertExecutionPlatform(config);
  const issues: string[] = [];
  validateExtensionEnvironment(
    snapshot.environment,
    config.extensions,
    managedExtensionCatalog,
    issues,
  );
  if (issues.length) throw new Error(issues.join("; "));
  return { config, selection };
}
export async function resolveEffectiveAdministrativeConfiguration(
  options: AdministrativeOptions = {},
) {
  const account = createAccountIdentityResolver(options.getAccountIdentity ?? readAccountIdentity);
  const machine = createMachineIdResolver(options.getMachineId ?? readMachineId);
  const snapshot = await loadAdministrativeSnapshot(
    options.configuration ?? buildLayout.configuration,
    sourceOptions({ ...options, getAccountIdentity: account, getMachineId: machine }),
  );
  const { config: overridden, selection: workspaceSelection } = selectSnapshot(
    snapshot,
    options.workspaceMode,
  );
  await validateManagedModelConfiguration(snapshot.models, overridden.modelAuth.personalProviders);
  const expanded = expandManagedHomePaths(
    overridden.filesystem,
    snapshot.environment,
    account,
    machine,
  );
  const config = Object.freeze({
    ...overridden,
    filesystem: expanded.filesystem,
    environment: expanded.environment,
  });
  const accountHome =
    config.execution.backend === "direct" ? undefined : await resolvePromptAccountHome(account);
  return {
    config,
    models: snapshot.models,
    provenance: snapshot.provenance,
    workspaceSelection,
    ...(accountHome === undefined ? {} : { accountHome }),
  };
}

/** Symbolic local validation never resolves environment files or account macros. */
export async function validateAdministrativeConfiguration(
  options: {
    readonly root?: string;
    readonly configPath?: string;
    readonly candidatePayload?: string;
    readonly configuration?: ConfigurationSource;
  } = {},
) {
  const source = options.configuration ?? buildLayout.configuration;
  if (source.source !== "local")
    throw new Error("--validate-installation requires a local configuration build");
  const root = options.root ?? "/";
  const { policy, modelsFile } = await loadConfig(
    underRoot(root, options.configPath ?? source.configPath),
    managedExtensionCatalog,
  );
  validatePolicy(policy);
  assertLocalAuditEndpoint(source, policy);
  const config = policy.workspace.modes[policy.workspace.default]!.config;
  const models = await readModelConfiguration(underRoot(root, modelsFile));
  await validateManagedModelConfiguration(models, config.modelAuth.personalProviders);
  if (options.candidatePayload !== undefined)
    await validateCandidateSkills(config.skills.directories, options.candidatePayload, false);
  return config;
}
async function validateCandidateSkills(
  directories: readonly string[],
  candidate: string,
  live: boolean,
): Promise<void> {
  let bundled = false;
  try {
    bundled = (await stat(join(candidate, "skills-modes.txt"))).isFile();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (bundled && !directories.includes(join(buildLayout.libexecDir, "skills")))
    throw new Error("Policy must admit the installed bundled skills root");
  await validateCandidateSkillDirectories(directories, buildLayout.libexecDir, candidate, live);
}
function candidateLayout(candidate: string): CompiledLayout {
  const remap = (path: string) =>
    path === buildLayout.libexecDir || path.startsWith(`${buildLayout.libexecDir}/`)
      ? join(candidate, path.slice(buildLayout.libexecDir.length))
      : path;
  return {
    ...buildLayout,
    ...(buildLayout.bubblewrap
      ? { bubblewrap: { ...buildLayout.bubblewrap, path: remap(buildLayout.bubblewrap.path) } }
      : {}),
    ...(buildLayout.toolBundle
      ? {
          toolBundle: {
            root: remap(buildLayout.toolBundle.root),
            commands: Object.fromEntries(
              Object.entries(buildLayout.toolBundle.commands).map(([name, path]) => [
                name,
                remap(path),
              ]),
            ),
          },
        }
      : {}),
    ...(buildLayout.hostTools
      ? {
          hostTools: Object.fromEntries(
            Object.entries(buildLayout.hostTools).map(([name, path]) => [name, remap(path)]),
          ),
        }
      : {}),
  };
}
function absolute(value: string | undefined): value is string {
  return value !== undefined && isAbsolute(value) && !value.includes("\0");
}
function validationFlags(args: readonly string[], allowed: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!;
    const value = args[i + 1];
    if (!allowed.includes(key) || flags.has(key) || !absolute(value))
      throw new Error("Invalid administrative validation arguments");
    flags.set(key, value);
  }
  return flags;
}
export function buildCapabilities() {
  return {
    platform: process.platform,
    architecture: process.arch,
    configuration_source: buildLayout.configuration.source,
    backends: process.platform === "linux" ? ["bubblewrap", "direct"] : ["seatbelt", "direct"],
    ...(buildLayout.bubblewrap ? { bubblewrap: buildLayout.bubblewrap } : {}),
    ...(buildLayout.toolBundle ? { tool_bundle: buildLayout.toolBundle } : {}),
    native_inventory: buildLayout.nativeInventory ?? {},
    host_tools: buildLayout.hostTools ?? {},
  };
}
export async function runAdministrativeCommand(
  args: readonly string[],
  configPath?: string,
): Promise<boolean> {
  const command = args[0];
  if (command === "--print-execution-backend")
    throw new Error("Use --print-build-capabilities or --validate-installation");
  if (command === "--print-build-capabilities") {
    if (args.length !== 1) throw new Error("--print-build-capabilities accepts no arguments");
    process.stdout.write(`${JSON.stringify(buildCapabilities())}\n`);
    return true;
  }
  if (command === "--validate-installation") {
    const flags = validationFlags(args.slice(1), ["--root", "--candidate-payload"]);
    const config = await validateAdministrativeConfiguration({
      ...Object.fromEntries(
        [...flags].map(([key, value]) => [key === "--root" ? "root" : "candidatePayload", value]),
      ),
      ...(configPath === undefined ? {} : { configPath }),
    });
    process.stdout.write(`${config.execution.backend}\n`);
    return true;
  }
  if (command === "--validate-service") {
    if (buildLayout.configuration.source !== "service")
      throw new Error("--validate-service requires a service configuration build");
    const flags = validationFlags(args.slice(1), ["--candidate-payload"]);
    const candidate = flags.get("--candidate-payload");
    if (candidate === undefined)
      throw new Error("--validate-service requires --candidate-payload DIR");
    const result = await resolveEffectiveAdministrativeConfiguration();
    createManagedModelRuntimeFactory({
      models: result.models,
      environment: result.config.environment.pi,
      personalProviders: result.config.modelAuth.personalProviders,
    });
    await validateCandidateSkills(result.config.skills.directories, candidate, true);
    const layout = candidateLayout(candidate);
    await assertExecutionPrerequisites(result.config.execution.backend, layout, []);
    if (result.config.execution.backend === "bubblewrap") {
      if (!layout.bubblewrap) throw new Error("Missing compiled Bubblewrap provider");
      let help: string;
      try {
        help = (
          await promisify(execFile)(layout.bubblewrap.path, ["--help"], {
            cwd: "/",
            env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
            timeout: 2000,
            maxBuffer: 256 * 1024,
            encoding: "utf8",
          })
        ).stdout;
      } catch {
        throw new Error("Compiled Bubblewrap executable capability check failed");
      }
      for (const option of [
        "--unshare-user",
        "--disable-userns",
        "--assert-userns-disabled",
        "--json-status-fd",
        "--seccomp",
        "--remount-ro",
        "--ro-bind-data",
      ])
        if (!help.includes(option))
          throw new Error(`Compiled Bubblewrap lacks required capability ${option}`);
    }
    process.stdout.write(
      `${JSON.stringify({ status: "valid", policy_schema: 16, platform: process.platform, revision: result.provenance.source === "service" ? result.provenance.revision : undefined })}\n`,
    );
    return true;
  }
  if (command === "--validate-bootstrap") {
    const file = args[1];
    if (file === undefined || file.startsWith("-") || file.includes("\0"))
      throw new Error("--validate-bootstrap requires a fixture file");
    const flags = validationFlags(args.slice(2), ["--candidate-payload"]);
    const candidate = flags.get("--candidate-payload");
    if (candidate === undefined)
      throw new Error("--validate-bootstrap requires --candidate-payload DIR");
    const envelope = parseStrictJson(
      await readBoundedUtf8File(file, 4 * 1024 * 1024, "Bootstrap fixture"),
    );
    if (!isRecord(envelope) || typeof envelope.request_id !== "string")
      throw new Error("Invalid bootstrap fixture");
    const result = parseServiceResponse(envelope, "bootstrap", envelope.request_id, 200);
    const snapshot = validateBootstrapResult(result, managedExtensionCatalog);
    const { config } = selectSnapshot(snapshot);
    await validateManagedModelConfiguration(snapshot.models, config.modelAuth.personalProviders);
    await validateCandidateSkills(config.skills.directories, candidate, false);
    process.stdout.write(
      `${JSON.stringify({ status: "valid", policy_schema: 16, platform: process.platform, revision: result.policy_revision })}\n`,
    );
    return true;
  }
  return false;
}
