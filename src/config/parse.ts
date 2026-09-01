import { parse as parseToml } from "@iarna/toml";

import {
  POLICY_MODES,
  EXECUTION_BACKENDS,
  NETWORK_MODES,
  SESSION_GRANT_POLICIES,
  TOOL_NAMES,
  type IdentityConfig,
  type ExtensionConfig,
  type ExecutionConfig,
  type NetworkConfig,
  type SandboxConfig,
  type SubjectPolicy,
  type ToolPolicies,
  isNormalizedAbsoluteFilePath,
  parseManagedEnvironment,
} from "../domain/index.js";
import type { ManagedExtensionCatalog } from "../managed-extensions/catalog.js";
import { ConfigError } from "./errors.js";

type UnknownRecord = Record<string, unknown>;

const ROOT_KEYS = [
  "config_version",
  "models_file",
  "execution",
  "identity",
  "network",
  "environment",
  "extensions",
  "tools",
] as const;
const POLICY_KEYS = ["mode", "session_grant"] as const;
const IDENTITY_MODES = ["disabled", "broker"] as const;

function isRecord(value: unknown): value is UnknownRecord {
  return (
    typeof value === "object" && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

function own(record: UnknownRecord, key: string): unknown {
  return Object.prototype.hasOwnProperty.call(record, key) ? record[key] : undefined;
}

function inspectKeys(
  record: UnknownRecord,
  expectedKeys: readonly string[],
  path: string,
  issues: string[],
): void {
  const expected = new Set(expectedKeys);

  for (const key of Object.keys(record).sort()) {
    if (!expected.has(key)) {
      issues.push(`${path}.${key} is not a recognized field`);
    }
  }

  for (const key of expectedKeys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      issues.push(`${path}.${key} is required`);
    }
  }
}

function inspectAllowedKeys(
  record: UnknownRecord,
  expectedKeys: readonly string[],
  path: string,
  issues: string[],
): void {
  const expected = new Set(expectedKeys);
  for (const key of Object.keys(record).sort()) {
    if (!expected.has(key)) issues.push(`${path}.${key} is not a recognized field`);
  }
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  allowed: T,
  path: string,
  issues: string[],
): T[number] | undefined {
  if (typeof value === "string" && (allowed as readonly string[]).includes(value)) {
    return value;
  }

  issues.push(`${path} must be one of: ${allowed.join(", ")}`);
  return undefined;
}

function parseSubjectPolicy(
  value: unknown,
  path: string,
  issues: string[],
): SubjectPolicy | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be a table`);
    return undefined;
  }

  inspectKeys(value, POLICY_KEYS, path, issues);
  const mode = enumValue(own(value, "mode"), POLICY_MODES, `${path}.mode`, issues);
  const sessionGrant = enumValue(
    own(value, "session_grant"),
    SESSION_GRANT_POLICIES,
    `${path}.session_grant`,
    issues,
  );

  if (mode !== "ask" && sessionGrant === "offer") {
    issues.push(`${path}.session_grant may be "offer" only when mode is "ask"`);
  }

  if (mode === undefined || sessionGrant === undefined) {
    return undefined;
  }

  return Object.freeze({ mode, sessionGrant });
}

function parseToolPolicies(
  value: unknown,
  toolNames: readonly string[],
  issues: string[],
): ToolPolicies | undefined {
  if (!isRecord(value)) {
    issues.push("config.tools must be a table");
    return undefined;
  }

  inspectKeys(value, toolNames, "config.tools", issues);
  const entries: Record<string, SubjectPolicy> = {};

  for (const toolName of toolNames) {
    const policy = parseSubjectPolicy(own(value, toolName), `config.tools.${toolName}`, issues);
    if (policy !== undefined) {
      entries[toolName] = policy;
    }
  }

  if (toolNames.some((toolName) => entries[toolName] === undefined)) {
    return undefined;
  }

  return Object.freeze(entries);
}

function parseExtensions(
  value: unknown,
  catalog: ManagedExtensionCatalog,
  issues: string[],
): Readonly<Record<string, ExtensionConfig>> | undefined {
  if (!isRecord(value)) {
    issues.push("config.extensions must be a table");
    return undefined;
  }
  inspectAllowedKeys(
    value,
    catalog.extensions.map((extension) => extension.id),
    "config.extensions",
    issues,
  );
  const result: Record<string, ExtensionConfig> = {};
  for (const id of Object.keys(value).sort()) {
    const definition = catalog.getExtension(id);
    if (definition === undefined) continue;
    const path = `config.extensions.${id}`;
    try {
      let settings;
      if (definition.kind === "pi-tool") {
        if (!isRecord(value[id])) throw new Error("must be a table");
        const keys = Object.keys(value[id]);
        if (keys.length > 0) throw new Error(`has unknown field: ${keys[0]}`);
        settings = Object.freeze({});
      } else {
        settings = definition.parseConfig(value[id], path);
      }
      if (!isRecord(settings)) throw new Error("must produce a configuration object");
      result[id] = Object.freeze({
        id,
        settings: Object.freeze({ ...settings }),
        toolNames: Object.freeze(
          definition.kind === "managed"
            ? definition.tools.map((tool) => tool.name)
            : [...definition.toolNames],
        ),
      });
    } catch (error) {
      issues.push(`${path} ${error instanceof Error ? error.message : "is invalid"}`);
    }
  }
  return Object.freeze(result);
}

function validateExtensionEnvironment(
  environment: ReturnType<typeof parseManagedEnvironment> | undefined,
  extensions: Readonly<Record<string, ExtensionConfig>> | undefined,
  catalog: ManagedExtensionCatalog,
  issues: string[],
): void {
  if (environment === undefined || extensions === undefined) return;
  for (const [extensionId, variables] of Object.entries(environment.extensions)) {
    if (!Object.hasOwn(extensions, extensionId)) {
      issues.push(
        `config.environment.extensions.${extensionId} requires config.extensions.${extensionId}`,
      );
      continue;
    }
    const definition = catalog.getExtension(extensionId);
    if (definition === undefined) continue;
    const accepted = new Set(definition.hostEnvironment.variables);
    for (const name of Object.keys(variables)) {
      if (!accepted.has(name)) {
        issues.push(
          `config.environment.extensions.${extensionId}.${name} is not declared by the compiled extension`,
        );
      }
    }
  }
}

function parseIdentity(value: unknown, issues: string[]): IdentityConfig | undefined {
  if (!isRecord(value)) {
    issues.push("config.identity must be a table");
    return undefined;
  }

  inspectKeys(value, ["mode"], "config.identity", issues);
  const mode = enumValue(own(value, "mode"), IDENTITY_MODES, "config.identity.mode", issues);
  return mode === undefined ? undefined : Object.freeze({ mode });
}

function parseNetwork(value: unknown, issues: string[]): NetworkConfig | undefined {
  if (!isRecord(value)) {
    issues.push("config.network must be a table");
    return undefined;
  }

  inspectKeys(value, ["mode"], "config.network", issues);
  const mode = enumValue(own(value, "mode"), NETWORK_MODES, "config.network.mode", issues);
  return mode === undefined ? undefined : Object.freeze({ mode });
}

function parseExecution(value: unknown, issues: string[]): ExecutionConfig | undefined {
  if (!isRecord(value)) {
    issues.push("config.execution must be a table");
    return undefined;
  }

  inspectKeys(value, ["backend"], "config.execution", issues);
  const backend = enumValue(
    own(value, "backend"),
    EXECUTION_BACKENDS,
    "config.execution.backend",
    issues,
  );
  return backend === undefined ? undefined : Object.freeze({ backend });
}

export function parseConfig(
  sourceText: string,
  source: string,
  catalog: ManagedExtensionCatalog,
): SandboxConfig {
  let parsed: unknown;
  try {
    parsed = parseToml(sourceText);
  } catch (error) {
    throw new ConfigError(source, ["TOML syntax is invalid"], error);
  }

  if (!isRecord(parsed)) {
    throw new ConfigError(source, ["config must be a table"]);
  }

  const issues: string[] = [];
  inspectKeys(parsed, ROOT_KEYS, "config", issues);

  const configVersion = own(parsed, "config_version");
  if (configVersion !== 5) {
    issues.push("config.config_version must be the integer 5");
  }

  const modelsFileValue = own(parsed, "models_file");
  const modelsFile = isNormalizedAbsoluteFilePath(modelsFileValue) ? modelsFileValue : undefined;
  if (modelsFile === undefined) {
    issues.push("config.models_file must be a normalized absolute file path");
  }

  const identity = parseIdentity(own(parsed, "identity"), issues);
  const execution = parseExecution(own(parsed, "execution"), issues);
  const network = parseNetwork(own(parsed, "network"), issues);
  let environment;
  try {
    environment = parseManagedEnvironment(own(parsed, "environment"));
  } catch {
    issues.push("config.environment must contain only valid pi, sandbox, and extensions tables");
  }
  if (execution?.backend === "direct" && network?.mode !== "host") {
    issues.push('config.network.mode must be "host" when config.execution.backend is "direct"');
  }
  const extensions = parseExtensions(own(parsed, "extensions"), catalog, issues);
  validateExtensionEnvironment(environment, extensions, catalog, issues);
  const selectedDefinitions =
    extensions === undefined
      ? []
      : catalog.extensions.filter((extension) => Object.hasOwn(extensions, extension.id));
  const toolNames = [
    ...TOOL_NAMES,
    ...selectedDefinitions.flatMap((extension) =>
      extension.kind === "managed" ? extension.tools.map((tool) => tool.name) : extension.toolNames,
    ),
  ];
  const tools = parseToolPolicies(own(parsed, "tools"), toolNames, issues);

  if (
    issues.length > 0 ||
    modelsFile === undefined ||
    identity === undefined ||
    execution === undefined ||
    network === undefined ||
    environment === undefined ||
    extensions === undefined ||
    tools === undefined
  ) {
    throw new ConfigError(source, issues);
  }

  return Object.freeze({
    configVersion: 5,
    modelsFile,
    execution,
    identity,
    network,
    environment,
    extensions,
    tools,
  });
}
