import { parse as parseToml } from "@iarna/toml";
import { assertJsonValue } from "../service/json.js";
import { snapshotCommandPathPrepend } from "../../packages/sandbox-extension/src/runtime/command-path.js";

import {
  type AuditConfig,
  COMMAND_CLASS_MODES,
  POLICY_MODES,
  EXECUTION_BACKENDS,
  NETWORK_MODES,
  SESSION_GRANT_POLICIES,
  TOOL_NAMES,
  type ExtensionConfig,
  type ExecutionConfig,
  type FilesystemConfig,
  type NetworkConfig,
  type SandboxConfig,
  type AuthoredSandboxConfig,
  type WorkspaceMode,
  type AuthoredPiEnvironmentValue,
  type SessionsConfig,
  type SkillsConfig,
  type ExportsConfig,
  type CommandClassPolicies,
  type CommandClassPolicy,
  type PolicyMode,
  type SessionGrantPolicy,
  type ToolPolicy,
  type ToolPolicies,
  type SubjectPolicy,
  isNormalizedAbsoluteFilePath,
  isNormalizedHiddenPath,
  isReservedHiddenDirectoryPath,
  parseAuthoredManagedEnvironment,
  validateAccountTemplate,
} from "../domain/index.js";
import type { ManagedExtensionCatalog } from "../managed-extensions/catalog.js";
import { COMMAND_CLASSES } from "../permissions/bash/contracts.js";
import {
  COMMAND_CLASS_TOOL,
  commandClassPolicyViolation,
  commandClassPreconditionIssues,
} from "../permissions/command-classes.js";
import { parseCodeModeConfig, parseMcpConfig } from "./mcp.js";
import { ConfigError } from "./errors.js";
import { assertGitDestinationBackend } from "./git-destination.js";
import { parseBashCommandSets } from "./command-sets.js";
import { SUBAGENTS_POLICY_SUBJECT, type SubagentsConfig } from "../domain/subagents.js";
import type { BashCommandSet } from "../permissions/bash/command-set-contracts.js";
import { isWorkspaceModeName, MAXIMUM_WORKSPACE_MODES } from "./workspace.js";

type UnknownRecord = Record<string, unknown>;

const ROOT_KEYS = [
  "config_version",
  "codemode",
  "mcp",
  "audit",
  "sessions",
  "exports",
  "execution",
  "filesystem",
  "model_auth",
  "network",
  "environment",
  "extensions",
  "tools",
] as const;
const POLICY_KEYS = ["mode", "session_grant"] as const;
const COMMAND_CLASS_POLICY_KEYS = ["mode", "session_grant"] as const;
const MODE_TOOLS = ["bash", "write", "edit"] as const;
export const MAXIMUM_CONFIG_BYTES = 1024 * 1024;

function parseSubagents(value: unknown, issues: string[]): SubagentsConfig | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    issues.push("config.subagents must be a table");
    return undefined;
  }
  inspectKeys(value, ["enabled"], "config.subagents", issues, ["max_concurrent", "max_total"]);
  const enabled = own(value, "enabled");
  const concurrentValue = own(value, "max_concurrent");
  const totalValue = own(value, "max_total");
  const maxConcurrent = concurrentValue === undefined ? 4 : concurrentValue;
  const maxTotal = totalValue === undefined ? 32 : totalValue;
  if (typeof enabled !== "boolean") issues.push("config.subagents.enabled must be a boolean");
  if (
    !Number.isSafeInteger(maxConcurrent) ||
    (maxConcurrent as number) < 1 ||
    (maxConcurrent as number) > 32
  )
    issues.push("config.subagents.max_concurrent must be an integer from 1 to 32");
  if (!Number.isSafeInteger(maxTotal) || (maxTotal as number) < 1 || (maxTotal as number) > 1024)
    issues.push("config.subagents.max_total must be an integer from 1 to 1024");
  return Object.freeze({
    enabled: enabled === true,
    maxConcurrent: maxConcurrent as number,
    maxTotal: maxTotal as number,
  });
}

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
  optionalKeys: readonly string[] = [],
): void {
  const expected = new Set([...expectedKeys, ...optionalKeys]);

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
  toolName: string,
  issues: string[],
): SubjectPolicy | undefined {
  if (!isRecord(value)) {
    issues.push(`${path} must be a table`);
    return undefined;
  }

  inspectKeys(
    value,
    POLICY_KEYS,
    path,
    issues,
    toolName === COMMAND_CLASS_TOOL ? [...COMMAND_CLASSES, "command_sets"] : [],
  );
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
  const commandClasses =
    toolName === COMMAND_CLASS_TOOL
      ? parseCommandClassPolicies(value, path, mode, sessionGrant, issues)
      : undefined;
  let commandSets;
  if (toolName === COMMAND_CLASS_TOOL && Object.hasOwn(value, "command_sets")) {
    try {
      commandSets = parseBashCommandSets(value.command_sets, `${path}.command_sets`);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : `${path}.command_sets is invalid`);
    }
  }

  if (mode === undefined || sessionGrant === undefined) {
    return undefined;
  }

  return Object.freeze({
    mode,
    sessionGrant,
    ...(commandClasses === undefined ? {} : { commandClasses }),
    ...(commandSets === undefined ? {} : { commandSets }),
  });
}

function parseCommandClassPolicies(
  value: UnknownRecord,
  path: string,
  mode: PolicyMode | undefined,
  sessionGrant: SessionGrantPolicy | undefined,
  issues: string[],
): CommandClassPolicies | undefined {
  const policies: Partial<Record<(typeof COMMAND_CLASSES)[number], CommandClassPolicy>> = {};
  for (const commandClass of COMMAND_CLASSES) {
    if (!Object.hasOwn(value, commandClass)) continue;
    const classPath = `${path}.${commandClass}`;
    const table = value[commandClass];
    if (!isRecord(table)) {
      issues.push(`${classPath} must be a table`);
      continue;
    }
    inspectKeys(table, COMMAND_CLASS_POLICY_KEYS, classPath, issues);
    const classMode = enumValue(
      own(table, "mode"),
      COMMAND_CLASS_MODES,
      `${classPath}.mode`,
      issues,
    );
    const classSessionGrant = enumValue(
      own(table, "session_grant"),
      SESSION_GRANT_POLICIES,
      `${classPath}.session_grant`,
      issues,
    );
    if (classMode !== "ask" && classSessionGrant === "offer") {
      issues.push(`${classPath}.session_grant may be "offer" only when mode is "ask"`);
      continue;
    }
    if (classMode === undefined || classSessionGrant === undefined) continue;
    const policy = Object.freeze({ mode: classMode, sessionGrant: classSessionGrant });
    if (mode === undefined || sessionGrant === undefined) continue;
    switch (commandClassPolicyViolation({ mode, sessionGrant }, policy)) {
      case "main_disabled":
        issues.push(
          `${classPath} is not permitted when ${path}.mode is "disabled"; availability is tool-level only`,
        );
        break;
      case "not_more_permissive":
        issues.push(
          `${classPath} must be strictly more permissive than ${path} (mode deny < ask < allow, or ask with session_grant "offer" over "never"); otherwise it has no effect`,
        );
        break;
      case undefined:
        policies[commandClass] = policy;
    }
  }
  return Object.keys(policies).length === 0 ? undefined : Object.freeze(policies);
}

function parseToolPolicies(
  value: unknown,
  toolNames: readonly string[],
  audit: Readonly<Record<string, boolean>>,
  issues: string[],
): ToolPolicies | undefined {
  if (!isRecord(value)) {
    issues.push("config.tools must be a table");
    return undefined;
  }

  inspectKeys(value, toolNames, "config.tools", issues);
  const entries: Record<string, ToolPolicy> = {};

  for (const toolName of toolNames) {
    const policy = parseSubjectPolicy(
      own(value, toolName),
      `config.tools.${toolName}`,
      toolName,
      issues,
    );
    const auditEnabled = audit[toolName];
    if (policy !== undefined && auditEnabled !== undefined) {
      entries[toolName] = Object.freeze({ ...policy, audit: auditEnabled });
    }
  }

  if (toolNames.some((toolName) => entries[toolName] === undefined)) {
    return undefined;
  }
  issues.push(...commandClassPreconditionIssues(entries, "config.tools"));

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

export function validateExtensionEnvironment(
  environment: Pick<ReturnType<typeof parseAuthoredManagedEnvironment>, "extensions"> | undefined,
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
  inspectKeys(value, ["enabled", "tools"], "config.audit", issues);
  const enabled = own(value, "enabled");
  if (typeof enabled !== "boolean") {
    issues.push("config.audit.enabled must be a boolean");
    return undefined;
  }
  return Object.freeze({ enabled });
}

function parseAuditTools(
  value: unknown,
  toolNames: readonly string[],
  issues: string[],
): Readonly<Record<string, boolean>> {
  const tools = isRecord(value) ? own(value, "tools") : undefined;
  if (!isRecord(tools)) {
    issues.push("config.audit.tools must be a table");
    return Object.freeze({});
  }
  inspectKeys(tools, toolNames, "config.audit.tools", issues);
  const entries: Array<[string, boolean]> = [];
  for (const name of toolNames) {
    const enabled = own(tools, name);
    if (typeof enabled !== "boolean") issues.push(`config.audit.tools.${name} must be a boolean`);
    else entries.push([name, enabled]);
  }
  return Object.freeze(Object.fromEntries(entries));
}

function parseExports(value: unknown, issues: string[]): ExportsConfig | undefined {
  if (!isRecord(value)) {
    issues.push("config.exports must be a table");
    return undefined;
  }
  inspectKeys(value, ["enabled"], "config.exports", issues);
  if (typeof value.enabled !== "boolean") {
    issues.push("config.exports.enabled must be a boolean");
    return undefined;
  }
  return Object.freeze({ enabled: value.enabled });
}

function parseSkills(value: unknown, issues: string[]): SkillsConfig | undefined {
  if (value === undefined) return Object.freeze({ directories: Object.freeze([]) });
  if (!isRecord(value)) {
    issues.push("config.skills must be a table");
    return undefined;
  }
  inspectKeys(value, ["directories"], "config.skills", issues);
  const directories = own(value, "directories");
  if (!Array.isArray(directories) || !directories.every(isNormalizedAbsoluteFilePath)) {
    issues.push(
      "config.skills.directories must contain normalized absolute directory paths other than /",
    );
    return undefined;
  }
  if (new Set(directories).size !== directories.length) {
    issues.push("config.skills.directories must not contain duplicate paths");
  }
  return Object.freeze({ directories: Object.freeze([...directories]) });
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

function parseModelAuth(value: unknown, issues: string[]): SandboxConfig["modelAuth"] | undefined {
  if (!isRecord(value)) {
    issues.push("config.model_auth must be a table");
    return undefined;
  }
  inspectKeys(value, ["personal_providers"], "config.model_auth", issues);
  const providers = value.personal_providers;
  if (
    !Array.isArray(providers) ||
    providers.length > 256 ||
    !providers.every(
      (p): p is string =>
        typeof p === "string" &&
        p.length > 0 &&
        Buffer.byteLength(p) <= 256 &&
        !/[\p{Cc}\uD800-\uDFFF]/u.test(p),
    ) ||
    new Set(providers).size !== providers.length
  ) {
    issues.push("config.model_auth.personal_providers must be distinct provider IDs");
    return undefined;
  }
  return Object.freeze({ personalProviders: Object.freeze([...providers]) });
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
  inspectKeys(value, ["cwd_writable", "hidden_paths", "denied_paths"], "config.filesystem", issues);
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
  const deniedPaths = own(value, "denied_paths");
  if (
    !Array.isArray(deniedPaths) ||
    deniedPaths.length > 63 ||
    !deniedPaths.every(isNormalizedHiddenPath) ||
    new Set(deniedPaths).size !== deniedPaths.length
  ) {
    issues.push(
      "config.filesystem.denied_paths must be an array of unique normalized absolute or home-relative directory paths",
    );
    return undefined;
  }
  try {
    deniedPaths.forEach(validateAccountTemplate);
  } catch {
    issues.push("config.filesystem.denied_paths contains invalid account macro syntax");
    return undefined;
  }
  return Object.freeze({
    cwdWritable,
    hiddenPaths: Object.freeze([...hiddenPaths].sort()),
    deniedPaths: Object.freeze([...deniedPaths].sort()),
  });
}

function parseExecution(value: unknown, issues: string[]): ExecutionConfig | undefined {
  if (!isRecord(value)) {
    issues.push("config.execution must be a table");
    return undefined;
  }

  inspectAllowedKeys(
    value,
    ["backend", "max_command_timeout_seconds", "command_path_prepend"],
    "config.execution",
    issues,
  );
  const backend = enumValue(
    own(value, "backend"),
    EXECUTION_BACKENDS,
    "config.execution.backend",
    issues,
  );
  let maximumTimeoutMs: number | undefined;
  if (Object.hasOwn(value, "max_command_timeout_seconds")) {
    const seconds = value.max_command_timeout_seconds;
    if (
      typeof seconds !== "number" ||
      !Number.isFinite(seconds) ||
      seconds <= 0 ||
      seconds * 1_000 > 2_147_483_647
    ) {
      issues.push(
        "config.execution.max_command_timeout_seconds must be positive finite seconds at most 2147483.647",
      );
    } else maximumTimeoutMs = Math.ceil(seconds * 1_000);
  }
  let commandPathPrepend: readonly string[] | undefined;
  if (Object.hasOwn(value, "command_path_prepend")) {
    try {
      commandPathPrepend = snapshotCommandPathPrepend(value.command_path_prepend);
    } catch (error) {
      issues.push(
        `config.execution.command_path_prepend: ${error instanceof Error ? error.message : "invalid command paths"}`,
      );
    }
  }
  return backend === undefined
    ? undefined
    : Object.freeze({
        backend,
        ...(maximumTimeoutMs === undefined ? {} : { maximumTimeoutMs }),
        ...(commandPathPrepend === undefined ? {} : { commandPathPrepend }),
      });
}

function parseCompleteConfig(
  parsed: UnknownRecord,
  source: string,
  catalog: ManagedExtensionCatalog,
): SandboxConfig<AuthoredPiEnvironmentValue> {
  const issues: string[] = [];
  inspectKeys(parsed, ROOT_KEYS, "config", issues, ["skills", "subagents", "extension_guidance"]);
  const guidanceValue = own(parsed, "extension_guidance");
  const extensionGuidance: Record<string, string> = {};
  if (guidanceValue !== undefined) {
    if (!isRecord(guidanceValue)) issues.push("config.extension_guidance must be a table");
    else {
      const known = new Set(["subagents", ...catalog.extensions.map((extension) => extension.id)]);
      let bytes = 0;
      for (const [id, value] of Object.entries(guidanceValue)) {
        if (!known.has(id))
          issues.push(`config.extension_guidance.${id} is not a compiled optional extension`);
        if (
          typeof value !== "string" ||
          value.trim().length === 0 ||
          Buffer.byteLength(value) > 16384 ||
          value.includes("\u0000")
        ) {
          issues.push(
            `config.extension_guidance.${id} must be nonempty text of at most 16384 bytes without NUL`,
          );
        } else {
          bytes += Buffer.byteLength(value);
          extensionGuidance[id] = value;
        }
      }
      if (bytes > 65536) issues.push("config.extension_guidance must total at most 65536 bytes");
    }
  }

  const configVersion = own(parsed, "config_version");
  if (configVersion !== 16) {
    issues.push("config.config_version must be the integer 16");
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
  const exports = parseExports(own(parsed, "exports"), issues);
  const skills = parseSkills(own(parsed, "skills"), issues);
  const subagents = parseSubagents(own(parsed, "subagents"), issues);
  const sessions = parseSessions(own(parsed, "sessions"), issues);
  const modelAuth = parseModelAuth(own(parsed, "model_auth"), issues);
  const execution = parseExecution(own(parsed, "execution"), issues);
  const filesystem = parseFilesystem(own(parsed, "filesystem"), issues);
  const network = parseNetwork(own(parsed, "network"), issues);
  let environment;
  try {
    environment = parseAuthoredManagedEnvironment(own(parsed, "environment"));
    for (const scope of [
      environment.pi,
      environment.sandbox,
      ...Object.values(environment.extensions),
    ]) {
      for (const value of Object.values(scope)) {
        if (typeof value === "string") validateAccountTemplate(value);
      }
    }
  } catch {
    issues.push("config.environment must contain only valid pi, sandbox, and extensions tables");
  }
  if (execution?.backend === "direct" && network?.mode !== "host") {
    issues.push('config.network.mode must be "host" when config.execution.backend is "direct"');
  }
  if (execution?.backend === "direct" && filesystem?.cwdWritable === false) {
    issues.push(
      'config.filesystem.cwd_writable must be true when config.execution.backend is "direct"',
    );
  }
  if (
    (execution?.backend === "direct" || execution?.backend === "seatbelt") &&
    filesystem !== undefined &&
    filesystem.hiddenPaths.length > 0
  ) {
    issues.push(
      `config.filesystem.hidden_paths must be empty when config.execution.backend is "${execution.backend}"`,
    );
  }
  if (execution?.backend !== "seatbelt" && filesystem && filesystem.deniedPaths.length > 0) {
    issues.push(
      'config.filesystem.denied_paths must be empty unless config.execution.backend is "seatbelt"',
    );
  }
  if (execution?.backend === "seatbelt") {
    if (network?.mode === "local")
      issues.push(
        'config.network.mode must be "none" or "host" when config.execution.backend is "seatbelt"',
      );
  }
  if (exports?.enabled && (execution?.backend === "direct" || filesystem?.cwdWritable !== false)) {
    issues.push(
      "config.exports.enabled requires a confined backend and config.filesystem.cwd_writable = false",
    );
  }
  const extensions = parseExtensions(own(parsed, "extensions"), catalog, issues);
  if (extensions !== undefined && execution !== undefined) {
    try {
      assertGitDestinationBackend(extensions, execution);
    } catch (error) {
      issues.push(error instanceof Error ? error.message : String(error));
    }
  }
  validateExtensionEnvironment(environment, extensions, catalog, issues);
  const selectedDefinitions =
    extensions === undefined
      ? []
      : catalog.extensions.filter((extension) => Object.hasOwn(extensions, extension.id));
  const toolNames = [
    ...TOOL_NAMES,
    ...(subagents?.enabled === true ? [SUBAGENTS_POLICY_SUBJECT] : []),
    ...selectedDefinitions.flatMap((extension) =>
      extension.kind === "managed" ? extension.tools.map((tool) => tool.name) : extension.toolNames,
    ),
  ];
  const auditTools = parseAuditTools(own(parsed, "audit"), toolNames, issues);
  const tools = parseToolPolicies(own(parsed, "tools"), toolNames, auditTools, issues);

  if (
    issues.length > 0 ||
    codemode === undefined ||
    mcp === undefined ||
    audit === undefined ||
    sessions === undefined ||
    skills === undefined ||
    exports === undefined ||
    modelAuth === undefined ||
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
    configVersion: 16,
    ...(guidanceValue === undefined ? {} : { extensionGuidance: Object.freeze(extensionGuidance) }),
    codemode,
    mcp,
    audit,
    sessions,
    skills,
    ...(subagents === undefined ? {} : { subagents }),
    exports,
    execution,
    modelAuth,
    network,
    filesystem,
    environment,
    extensions,
    tools,
  });
}

/** Stable comparison of parsed set-valued fields, without executable/path resolution. */
function canonicalCommandSet(rule: BashCommandSet): string {
  return JSON.stringify({
    commands: [...rule.commands].sort(),
    mode: rule.mode,
    sessionGrant: rule.sessionGrant,
    requiredFlags: [...rule.requiredFlags].sort(),
    optionalFlags: [...rule.optionalFlags].sort(),
    options: Object.fromEntries(
      Object.keys(rule.options)
        .sort()
        .map((name) => {
          const option = rule.options[name]!;
          return [
            name,
            option.kind === "values"
              ? { kind: option.kind, values: [...option.values].sort() }
              : { kind: option.kind },
          ];
        }),
    ),
    operands: { min: rule.operands.min, max: rule.operands.max },
  });
}

function modeProvenance(issue: string, name: string, mode: UnknownRecord): string {
  const mapped = issue.replace(
    /config\.(filesystem\.cwd_writable|exports\.enabled|tools\.(?:bash|write|edit))\b/gu,
    (path, field: string) => {
      const [table, key] = field.split(".");
      const overlay = own(mode, table!);
      return isRecord(overlay) && Object.hasOwn(overlay, key!)
        ? `config.workspace.modes.${name}.${field}`
        : path;
    },
  );
  return `workspace mode ${JSON.stringify(name)}: ${mapped}`;
}

export interface LocalPolicySource {
  readonly modelsFile: string;
  readonly policy: AuthoredSandboxConfig<AuthoredPiEnvironmentValue>;
}

/** The local adapter consumes the sole file-source field before common validation. */
export function parseConfig(
  sourceText: string,
  source: string,
  catalog: ManagedExtensionCatalog,
): LocalPolicySource {
  if (Buffer.byteLength(sourceText) > MAXIMUM_CONFIG_BYTES)
    throw new ConfigError(source, [`configuration exceeds ${MAXIMUM_CONFIG_BYTES} bytes`]);
  let parsed: unknown;
  try {
    parsed = parseToml(sourceText);
  } catch {
    throw new ConfigError(source, ["TOML syntax is invalid"]);
  }
  try {
    assertJsonValue(parsed);
  } catch {
    throw new ConfigError(source, ["TOML must contain valid JSON-compatible policy values"]);
  }
  if (isRecord(parsed) && !Object.hasOwn(parsed, "models_file"))
    throw new ConfigError(source, ["config.models_file is required"]);
  if (!isRecord(parsed) || !isNormalizedAbsoluteFilePath(parsed.models_file))
    throw new ConfigError(source, ["config.models_file must be a normalized absolute file path"]);
  const { models_file: modelsFile, ...policy } = parsed;
  return Object.freeze({ modelsFile, policy: parseSourcePolicy(policy, source, catalog) });
}

/** Validate every authored mode identically for local and service sources. */
export function parseSourcePolicy(
  parsed: unknown,
  source: string,
  catalog: ManagedExtensionCatalog,
): AuthoredSandboxConfig<AuthoredPiEnvironmentValue> {
  try {
    assertJsonValue(parsed);
  } catch {
    throw new ConfigError(source, ["policy contains invalid JSON values"]);
  }
  if (!isRecord(parsed)) throw new ConfigError(source, ["config must be a table"]);
  const issues: string[] = [];
  inspectKeys(
    parsed,
    [...ROOT_KEYS.filter((key) => key !== "exports"), "workspace"],
    "config",
    issues,
    ["exports", "skills", "subagents", "extension_guidance"],
  );
  if (own(parsed, "config_version") !== 16) {
    issues.push("config.config_version must be the integer 16");
    throw new ConfigError(source, issues);
  }
  const workspace = own(parsed, "workspace");
  if (!isRecord(workspace)) {
    issues.push("config.workspace must be a table");
    throw new ConfigError(source, issues);
  }
  inspectKeys(workspace, ["default", "allowed", "modes"], "config.workspace", issues);
  const defaultName = own(workspace, "default");
  if (!isWorkspaceModeName(defaultName))
    issues.push("config.workspace.default must be a valid mode identifier");
  const allowed = own(workspace, "allowed");
  if (
    !Array.isArray(allowed) ||
    allowed.length === 0 ||
    allowed.length > MAXIMUM_WORKSPACE_MODES ||
    !allowed.every(isWorkspaceModeName) ||
    new Set(allowed).size !== allowed.length
  )
    issues.push("config.workspace.allowed must contain 1–32 distinct mode identifiers");
  const modes = own(workspace, "modes");
  if (
    !isRecord(modes) ||
    Object.keys(modes).length === 0 ||
    Object.keys(modes).length > MAXIMUM_WORKSPACE_MODES
  ) {
    issues.push("config.workspace.modes must contain 1–32 mode definitions");
    throw new ConfigError(source, issues);
  }
  if (typeof defaultName === "string" && !Object.hasOwn(modes, defaultName))
    issues.push(`config.workspace.default names an undefined mode: ${JSON.stringify(defaultName)}`);
  if (Array.isArray(allowed)) {
    for (const name of allowed) {
      if (typeof name === "string" && !Object.hasOwn(modes, name))
        issues.push(`config.workspace.allowed names an undefined mode: ${JSON.stringify(name)}`);
    }
    if (!allowed.includes(defaultName))
      issues.push("config.workspace.default must belong to config.workspace.allowed");
  }

  // Check authored entries even when every mode replaces them. Only effective
  // relationships (such as read-tool prerequisites and exports/CWD) wait for composition.
  const commonFilesystem = own(parsed, "filesystem");
  if (isRecord(commonFilesystem))
    parseFilesystem(
      {
        ...commonFilesystem,
        cwd_writable: Object.hasOwn(commonFilesystem, "cwd_writable")
          ? commonFilesystem.cwd_writable
          : true,
      },
      issues,
    );
  else issues.push("config.filesystem must be a table");
  if (Object.hasOwn(parsed, "exports")) parseExports(parsed.exports, issues);
  const commandSets = new Map<string, { canonical: string; path: string }>();
  const inspectPolicy = (value: unknown, path: string, name: string) => {
    const policy = parseSubjectPolicy(value, path, name, issues);
    for (const [id, rule] of Object.entries(policy?.commandSets ?? {})) {
      const location = `${path}.command_sets.${id}`;
      const canonical = canonicalCommandSet(rule);
      const previous = commandSets.get(id);
      if (previous !== undefined && previous.canonical !== canonical)
        issues.push(`${location} conflicts with the command-set definition at ${previous.path}`);
      else commandSets.set(id, { canonical, path: location });
    }
  };
  const commonTools = own(parsed, "tools");
  if (isRecord(commonTools)) {
    for (const [name, value] of Object.entries(commonTools))
      inspectPolicy(value, `config.tools.${name}`, name);
  } else issues.push("config.tools must be a table");

  for (const [name, mode] of Object.entries(modes)) {
    const path = `config.workspace.modes.${name}`;
    if (!isWorkspaceModeName(name)) issues.push(`${path} has an invalid mode identifier`);
    if (!isRecord(mode)) {
      issues.push(`${path} must be a table`);
      continue;
    }
    inspectAllowedKeys(mode, ["description", "filesystem", "exports", "tools"], path, issues);
    if (Object.hasOwn(mode, "description")) {
      const description = mode.description;
      if (
        typeof description !== "string" ||
        description.trim().length === 0 ||
        Buffer.byteLength(description) > 256 ||
        /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uD800-\uDFFF]/u.test(description)
      )
        issues.push(
          `${path}.description must be nonblank single-line text of at most 256 bytes without control characters`,
        );
    }
    for (const [table, field] of [
      ["filesystem", "cwd_writable"],
      ["exports", "enabled"],
    ] as const) {
      if (!Object.hasOwn(mode, table)) continue;
      const entry = mode[table];
      if (!isRecord(entry)) issues.push(`${path}.${table} must be a table`);
      else {
        inspectKeys(entry, [field], `${path}.${table}`, issues);
        if (typeof own(entry, field) !== "boolean")
          issues.push(`${path}.${table}.${field} must be a boolean`);
      }
    }
    if (Object.hasOwn(mode, "tools")) {
      const entries = mode.tools;
      if (!isRecord(entries) || Object.keys(entries).length === 0)
        issues.push(`${path}.tools must be a nonempty table`);
      else {
        inspectAllowedKeys(entries, MODE_TOOLS, `${path}.tools`, issues);
        for (const [tool, value] of Object.entries(entries))
          inspectPolicy(value, `${path}.tools.${tool}`, tool);
      }
    }
  }
  if (issues.length > 0) throw new ConfigError(source, issues);

  const common = { ...parsed };
  delete common.workspace;
  const resolved: Array<[string, WorkspaceMode<AuthoredPiEnvironmentValue>]> = [];
  for (const [name, rawMode] of Object.entries(modes)) {
    const mode = rawMode as UnknownRecord;
    const composed = {
      ...common,
      filesystem: {
        ...(commonFilesystem as UnknownRecord),
        ...(mode.filesystem as UnknownRecord | undefined),
      },
      ...(mode.exports === undefined ? {} : { exports: mode.exports }),
      tools: { ...(commonTools as UnknownRecord), ...(mode.tools as UnknownRecord | undefined) },
    };
    try {
      const config = parseCompleteConfig(composed, source, catalog);
      resolved.push([
        name,
        Object.freeze({
          ...(mode.description === undefined ? {} : { description: mode.description as string }),
          config,
        }),
      ]);
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error;
      issues.push(...error.issues.map((issue) => modeProvenance(issue, name, mode)));
    }
  }
  if (issues.length > 0) throw new ConfigError(source, issues);
  return Object.freeze({
    workspace: Object.freeze({
      default: defaultName as string,
      allowed: Object.freeze([...(allowed as string[])].sort()),
      modes: Object.freeze(Object.fromEntries(resolved)),
    }),
  });
}
