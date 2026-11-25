import { isAbsolute, join, resolve } from "node:path";
import type {
  AccountOverrides,
  AuthoredPiEnvironmentValue,
  AuthoredSandboxConfig,
  ManagedEnvironment,
  ResolvedPiEnvironmentValue,
  WorkspaceOverrides,
} from "../domain/index.js";
import { parseResolvedManagedEnvironment } from "../domain/index.js";
import type { ManagedExtensionCatalog } from "../managed-extensions/catalog.js";
import type { ConfigurationSource } from "../service/endpoint.js";
import { freezeJson, isRecord, parseStrictJson } from "../service/json.js";
import { readBoundedUtf8File } from "../service/files.js";
import type {
  BootstrapResult,
  ClientMetadata,
  PolicyOrigin,
  ServiceTransport,
} from "../service/protocol.js";
import { loadConfig } from "./load.js";
import { parseSourcePolicy } from "./parse.js";
import { parseAccountOverrides, parseWorkspaceOverrides } from "./account-overrides.js";
import { resolveEnvironmentFiles } from "../runtime/environment-files.js";

export type ConfigurationProvenance =
  | { readonly source: "local"; readonly configPath: string; readonly modelsPath: string }
  | {
      readonly source: "service";
      readonly transport: "unix" | "https";
      readonly location: string;
      readonly revision: string;
      readonly identitySource: "unix_peer" | "https_assertion";
    };
export interface AdministrativeSnapshot {
  readonly policy: AuthoredSandboxConfig<AuthoredPiEnvironmentValue>;
  readonly overrides: AccountOverrides;
  readonly environment: ManagedEnvironment<ResolvedPiEnvironmentValue>;
  readonly models: Readonly<Record<string, unknown>>;
  readonly provenance: ConfigurationProvenance;
}
export interface AdministrativeSourceOptions {
  readonly catalog: ManagedExtensionCatalog;
  readonly service?: ServiceTransport;
  readonly client: ClientMetadata;
  readonly configPath?: string;
  /** Platform/capability checks run on all modes before local catalog/secret reads. */
  readonly validatePolicy: (policy: AuthoredSandboxConfig<AuthoredPiEnvironmentValue>) => void;
}
export function underRoot(root: string, path: string): string {
  if (!isAbsolute(root) || !isAbsolute(path))
    throw new Error("Administrative paths must be absolute");
  return resolve(root) === "/" ? path : join(resolve(root), path.slice(1));
}
export async function readModelConfiguration(
  path: string,
): Promise<Readonly<Record<string, unknown>>> {
  const value = parseStrictJson(
    await readBoundedUtf8File(path, 2 * 1024 * 1024, "Model catalog"),
    2 * 1024 * 1024,
  );
  if (!isRecord(value)) throw new Error("Model catalog must be an object");
  return freezeJson(value);
}
function serviceFor(options: AdministrativeSourceOptions): ServiceTransport {
  if (!options.service) throw new Error("Managed service transport is unavailable");
  return options.service;
}
export function validateBootstrapResult(
  result: BootstrapResult,
  catalog: ManagedExtensionCatalog,
): Omit<AdministrativeSnapshot, "provenance"> {
  const policy = parseSourcePolicy(result.policy, "service policy", catalog);
  const overrides = parseAccountOverrides(result.overrides);
  const environment = parseResolvedManagedEnvironment(result.environment);
  if (!isRecord(result.models)) throw new Error("Invalid service model catalog");
  return freezeJson({ policy, overrides, environment, models: structuredClone(result.models) });
}
export async function inspectAdministrativePolicy(
  configuration: ConfigurationSource,
  options: AdministrativeSourceOptions,
): Promise<{
  readonly policy: AdministrativeSnapshot["policy"];
  readonly workspaceOverrides?: WorkspaceOverrides;
}> {
  if (configuration.source === "local") {
    const { policy } = await loadConfig(
      options.configPath ?? configuration.configPath,
      options.catalog,
    );
    options.validatePolicy(policy);
    assertLocalAuditEndpoint(configuration, policy);
    return { policy };
  }
  if (options.configPath !== undefined)
    throw new Error("Service builds do not permit local configuration");
  const result = await serviceFor(options).request("policy_inspect", {
    policy_schema: 16,
    model_schema: "pi-1.5.0",
    client: options.client,
  });
  const policy = parseSourcePolicy(result.policy, "service policy", options.catalog);
  options.validatePolicy(policy);
  return {
    policy,
    ...(result.workspace_overrides === null
      ? {}
      : { workspaceOverrides: parseWorkspaceOverrides(result.workspace_overrides) }),
  };
}
export async function loadAdministrativeSnapshot(
  configuration: ConfigurationSource,
  options: AdministrativeSourceOptions,
): Promise<AdministrativeSnapshot> {
  if (configuration.source === "local") {
    const configPath = options.configPath ?? configuration.configPath;
    const { policy, modelsFile } = await loadConfig(configPath, options.catalog);
    options.validatePolicy(policy);
    assertLocalAuditEndpoint(configuration, policy);
    const models = await readModelConfiguration(modelsFile);
    const shared = policy.workspace.modes[policy.workspace.default]!.config;
    const environment = await resolveEnvironmentFiles(shared.environment);
    return freezeJson({
      policy,
      overrides: { tools: {} },
      environment,
      models,
      provenance: { source: "local", configPath, modelsPath: modelsFile },
    });
  }
  if (options.configPath !== undefined)
    throw new Error("Service builds do not permit local configuration");
  const result = await serviceFor(options).request("bootstrap", {
    policy_schema: 16,
    model_schema: "pi-1.5.0",
    client: options.client,
  });
  const snapshot = validateBootstrapResult(result, options.catalog);
  options.validatePolicy(snapshot.policy);
  const endpoint = configuration.endpoint;
  return freezeJson({
    ...snapshot,
    provenance: {
      source: "service",
      transport: endpoint.transport,
      location: endpoint.transport === "unix" ? endpoint.socketPath : new URL(endpoint.url).origin,
      revision: result.policy_revision,
      identitySource: endpoint.transport === "unix" ? "unix_peer" : "https_assertion",
    },
  });
}
export function assertLocalAuditEndpoint(
  configuration: ConfigurationSource,
  policy: AdministrativeSnapshot["policy"],
): void {
  if (
    configuration.source === "local" &&
    !configuration.auditEndpoint &&
    Object.values(policy.workspace.modes).some((mode) => mode.config.audit.enabled)
  )
    throw new Error("Local policy enables auditing but this build has no audit endpoint");
}
export function policyOrigin(provenance: ConfigurationProvenance): PolicyOrigin {
  return provenance.source === "local"
    ? { source: "local" }
    : { source: "service", revision: provenance.revision };
}
