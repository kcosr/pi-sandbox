import { parse as parseToml } from "@iarna/toml";

import {
  AUDIT_FACILITIES,
  type AuditConfig,
  POLICY_MODES,
  EXECUTION_BACKENDS,
  NETWORK_MODES,
  PROCESS_LIFETIMES,
  SESSION_GRANT_POLICIES,
  TOOL_NAMES,
  type IdentityConfig,
  type ExtensionConfig,
  type ExecutionConfig,
  type FilesystemConfig,
  type NetworkConfig,
  type SandboxConfig,
  type SmolvmConfig,
  type SessionsConfig,
  type ToolPolicy,
  type ToolPolicies,
  isNormalizedAbsoluteFilePath,
  isNormalizedHiddenPath,
  isReservedHiddenDirectoryPath,
  parseManagedEnvironment,
  validateAccountTemplate,
} from "../domain/index.js";
import type { ManagedExtensionCatalog } from "../managed-extensions/catalog.js";
import { parseCodeModeConfig, parseMcpConfig } from "./mcp.js";
import { ConfigError } from "./errors.js";

type UnknownRecord = Record<string, unknown>;

const ROOT_KEYS = [
  "config_version",
  "models_file",
  "codemode",
  "mcp",
  "audit",
  "sessions",
  "execution",
  "filesystem",
  "identity",
  "network",
  "environment",
  "extensions",
  "tools",
] as const;
const POLICY_KEYS = ["mode", "session_grant", "audit"] as const;
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
): ToolPolicy | undefined {
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

  const audit = own(value, "audit");
  if (typeof audit !== "boolean") {
    issues.push(`${path}.audit must be a boolean`);
    return undefined;
  }
  return Object.freeze({ mode, sessionGrant, audit });
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
  const entries: Record<string, ToolPolicy> = {};

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

function parseAudit(value: unknown, issues: string[]): AuditConfig | undefined {
  if (!isRecord(value)) {
    issues.push("config.audit must be a table");
    return undefined;
  }
  inspectKeys(value, ["enabled", "facility"], "config.audit", issues);
  const enabled = own(value, "enabled");
  const facility = enumValue(
    own(value, "facility"),
    AUDIT_FACILITIES,
    "config.audit.facility",
    issues,
  );
  if (typeof enabled !== "boolean") issues.push("config.audit.enabled must be a boolean");
  if (typeof enabled !== "boolean" || facility === undefined) return undefined;
  return Object.freeze({ enabled, facility });
}

function parseSessions(value: unknown, issues: string[]): SessionsConfig | undefined {
  if (!isRecord(value)) {
    issues.push("config.sessions must be a table");
    return undefined;
  }
  inspectKeys(value, ["retention_days"], "config.sessions", issues);
  const retentionDays = own(value, "retention_days");
  if (
    typeof retentionDays !== "number" ||
    !Number.isSafeInteger(retentionDays) ||
    retentionDays < 0 ||
    retentionDays > 36_500
  ) {
    issues.push("config.sessions.retention_days must be an integer between 0 and 36500");
    return undefined;
  }
  return Object.freeze({ retentionDays });
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

function parseFilesystem(value: unknown, issues: string[]): FilesystemConfig | undefined {
  if (!isRecord(value)) {
    issues.push("config.filesystem must be a table");
    return undefined;
  }
  inspectKeys(value, ["cwd_writable", "hidden_paths"], "config.filesystem", issues);
  const cwdWritable = own(value, "cwd_writable");
  if (typeof cwdWritable !== "boolean") {
    issues.push("config.filesystem.cwd_writable must be a boolean");
    return undefined;
  }
  const hiddenPaths = own(value, "hidden_paths");
  if (
    !Array.isArray(hiddenPaths) ||
    !hiddenPaths.every(isNormalizedHiddenPath) ||
    new Set(hiddenPaths).size !== hiddenPaths.length
  ) {
    issues.push(
      "config.filesystem.hidden_paths must be an array of unique normalized absolute or home-relative paths",
    );
    return undefined;
  }
  try {
    hiddenPaths.forEach(validateAccountTemplate);
  } catch {
    issues.push("config.filesystem.hidden_paths contains invalid account macro syntax");
    return undefined;
  }
  if (hiddenPaths.some(isReservedHiddenDirectoryPath)) {
    issues.push(
      "config.filesystem.hidden_paths must not overlap private system paths or hide /tmp",
    );
    return undefined;
  }
  return Object.freeze({ cwdWritable, hiddenPaths: Object.freeze([...hiddenPaths].sort()) });
}

function parseExecution(value: unknown, issues: string[]): ExecutionConfig | undefined {
  if (!isRecord(value)) {
    issues.push("config.execution must be a table");
    return undefined;
  }

  inspectAllowedKeys(value, ["backend", "process_lifetime"], "config.execution", issues);
  const backend = enumValue(
    own(value, "backend"),
    EXECUTION_BACKENDS,
    "config.execution.backend",
    issues,
  );
  if (backend === "smolvm" && Object.hasOwn(value, "process_lifetime")) {
    issues.push(
      "config.execution.process_lifetime is not supported by smolvm; its processes live with the VM",
    );
  }
  const processLifetime = Object.hasOwn(value, "process_lifetime")
    ? enumValue(
        value.process_lifetime,
        PROCESS_LIFETIMES,
        "config.execution.process_lifetime",
        issues,
      )
    : backend === "smolvm"
      ? "sandbox"
      : "command";
  return backend === undefined || processLifetime === undefined
    ? undefined
    : Object.freeze({ backend, processLifetime });
}

function validSmolvmPath(value: unknown): value is string {
  return isNormalizedAbsoluteFilePath(value) && !value.includes(":");
}

function parseSmolvm(value: unknown, issues: string[]): SmolvmConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push("config.smolvm must be a table");
    return undefined;
  }
  inspectKeys(
    value,
    [
      "image",
      "image_sha256",
      "state_directory",
      "cpus",
      "memory_mib",
      "storage_gib",
      "overlay_gib",
    ],
    "config.smolvm",
    issues,
  );
  const image = own(value, "image");
  const stateDirectory = own(value, "state_directory");
  const imageSha256 = own(value, "image_sha256");
  if (!validSmolvmPath(image))
    issues.push("config.smolvm.image must be a normalized absolute path");
  if (!validSmolvmPath(stateDirectory))
    issues.push("config.smolvm.state_directory must be a normalized absolute path below /");
  if (typeof stateDirectory === "string") {
    try {
      validateAccountTemplate(stateDirectory);
    } catch {
      issues.push("config.smolvm.state_directory has invalid account macro syntax");
    }
    if (!stateDirectory.includes("{{") && Buffer.byteLength(stateDirectory) > 48)
      issues.push("config.smolvm.state_directory must be at most 48 bytes");
  }
  if (typeof imageSha256 !== "string" || !/^[0-9a-f]{64}$/u.test(imageSha256))
    issues.push("config.smolvm.image_sha256 must be a lowercase SHA-256 digest");
  const bounded = (key: string, minimum: number, maximum: number): number | undefined => {
    const input = own(value, key);
    if (
      typeof input !== "number" ||
      !Number.isSafeInteger(input) ||
      input < minimum ||
      input > maximum
    ) {
      issues.push(`config.smolvm.${key} must be an integer from ${minimum} to ${maximum}`);
      return undefined;
    }
    return input;
  };
  const cpus = bounded("cpus", 1, 32);
  const memoryMiB = bounded("memory_mib", 256, 65536);
  const storageGiB = bounded("storage_gib", 1, 64);
  const overlayGiB = bounded("overlay_gib", 1, 64);
  if (
    !validSmolvmPath(image) ||
    !validSmolvmPath(stateDirectory) ||
    typeof imageSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(imageSha256) ||
    cpus === undefined ||
    memoryMiB === undefined ||
    storageGiB === undefined ||
    overlayGiB === undefined
  )
    return undefined;
  return Object.freeze({
    image,
    imageSha256,
    stateDirectory,
    cpus,
    memoryMiB,
    storageGiB,
    overlayGiB,
  });
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
  // Backend-specific image configuration is optional for ordinary distributions.
  inspectKeys(
    Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "smolvm")),
    ROOT_KEYS,
    "config",
    issues,
  );

  const configVersion = own(parsed, "config_version");
  if (configVersion !== 11) {
    issues.push("config.config_version must be the integer 11");
  }

  const modelsFileValue = own(parsed, "models_file");
  const modelsFile = isNormalizedAbsoluteFilePath(modelsFileValue) ? modelsFileValue : undefined;
  if (modelsFile === undefined) {
    issues.push("config.models_file must be a normalized absolute file path");
  }

  let codemode;
  let mcp;
  try {
    codemode = parseCodeModeConfig(own(parsed, "codemode"));
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "config.codemode is invalid");
  }
  try {
    mcp = parseMcpConfig(own(parsed, "mcp"), codemode);
  } catch (error) {
    issues.push(error instanceof Error ? error.message : "config.mcp is invalid");
  }
  const audit = parseAudit(own(parsed, "audit"), issues);
  const sessions = parseSessions(own(parsed, "sessions"), issues);
  const identity = parseIdentity(own(parsed, "identity"), issues);
  const execution = parseExecution(own(parsed, "execution"), issues);
  const smolvm = parseSmolvm(own(parsed, "smolvm"), issues);
  const filesystem = parseFilesystem(own(parsed, "filesystem"), issues);
  const network = parseNetwork(own(parsed, "network"), issues);
  let environment;
  try {
    environment = parseManagedEnvironment(own(parsed, "environment"));
    for (const scope of [
      environment.pi,
      environment.sandbox,
      ...Object.values(environment.extensions),
    ]) {
      Object.values(scope).forEach(validateAccountTemplate);
    }
  } catch {
    issues.push("config.environment must contain only valid pi, sandbox, and extensions tables");
  }
  if (execution?.backend === "direct" && network?.mode !== "host") {
    issues.push('config.network.mode must be "host" when config.execution.backend is "direct"');
  }
  if (execution?.backend === "direct" && execution.processLifetime !== "command") {
    issues.push(
      'config.execution.process_lifetime must be "command" when config.execution.backend is "direct"',
    );
  }
  if (execution?.backend === "direct" && filesystem?.cwdWritable === false) {
    issues.push(
      'config.filesystem.cwd_writable must be true when config.execution.backend is "direct"',
    );
  }
  if (
    execution?.backend === "direct" &&
    filesystem !== undefined &&
    filesystem.hiddenPaths.length > 0
  ) {
    issues.push(
      'config.filesystem.hidden_paths must be empty when config.execution.backend is "direct"',
    );
  }
  if (execution?.backend === "smolvm") {
    if (smolvm === undefined)
      issues.push("config.smolvm is required when config.execution.backend is smolvm");
    if (network?.mode !== "none")
      issues.push('config.network.mode must be "none" when config.execution.backend is "smolvm"');
    if (filesystem !== undefined && filesystem.hiddenPaths.length > 0)
      issues.push(
        'config.filesystem.hidden_paths must be empty when config.execution.backend is "smolvm"',
      );
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
    codemode === undefined ||
    mcp === undefined ||
    audit === undefined ||
    sessions === undefined ||
    identity === undefined ||
    execution === undefined ||
    network === undefined ||
    filesystem === undefined ||
    environment === undefined ||
    extensions === undefined ||
    tools === undefined
  ) {
    throw new ConfigError(source, issues);
  }

  return Object.freeze({
    configVersion: 11,
    codemode,
    mcp,
    audit,
    sessions,
    modelsFile,
    execution,
    ...(smolvm === undefined ? {} : { smolvm }),
    identity,
    network,
    filesystem,
    environment,
    extensions,
    tools,
  });
}
