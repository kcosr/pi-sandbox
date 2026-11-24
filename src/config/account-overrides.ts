import { assertGitDestinationBackend } from "./git-destination.js";
import { assertMcpCodeModeExposure } from "./mcp.js";
import {
  COMMAND_CLASS_MODES,
  POLICY_MODES,
  NETWORK_MODES,
  SESSION_GRANT_POLICIES,
  isMcpToolPattern,
  type AuthoredPiEnvironmentValue,
  type McpApprovalPolicy,
  type McpApprovalRule,
  type McpPolicyLayer,
  type ExecutionConfig,
  type FilesystemConfig,
  type NetworkConfig,
  type SandboxConfig,
  type CommandClassPolicy,
  type SubjectPolicy,
  type ToolPolicy,
  type AccountOverrides,
} from "../domain/index.js";
import { COMMAND_CLASSES, type CommandClass } from "../permissions/bash/contracts.js";
import {
  COMMAND_CLASS_TOOL,
  commandClassAllowRequirements,
  commandClassPolicyViolation,
  commandClassPreconditionIssues,
} from "../permissions/command-classes.js";

export function applyAccountOverrides<PiValue extends AuthoredPiEnvironmentValue>(
  base: SandboxConfig<PiValue>,
  overrides: AccountOverrides,
): SandboxConfig<PiValue> {
  const availableTools = new Set(Object.keys(base.tools));
  for (const toolName of Object.keys(overrides.tools)) {
    if (!availableTools.has(toolName)) {
      throw new Error(
        `configuration service returned an override for unavailable tool: ${toolName}`,
      );
    }
  }
  const tools = Object.fromEntries(
    Object.keys(base.tools).map((toolName) => [
      toolName,
      overrides.tools[toolName] === undefined
        ? base.tools[toolName]
        : Object.freeze({
            mode: overrides.tools[toolName].mode,
            sessionGrant: overrides.tools[toolName].sessionGrant,
            ...(overrides.tools[toolName].commandClasses === undefined
              ? {}
              : { commandClasses: overrides.tools[toolName].commandClasses }),
            audit: base.tools[toolName]!.audit,
            ...(base.tools[toolName]!.commandSets === undefined
              ? {}
              : { commandSets: base.tools[toolName]!.commandSets }),
          }),
    ]),
  ) as Record<string, ToolPolicy>;
  assertEffectiveCommandClassPolicies(tools);
  const mcp = applyMcpOverrides(base.mcp, overrides.mcp);
  assertMcpCodeModeExposure(mcp, base.codemode);
  assertGitDestinationBackend(
    base.extensions,
    applyExecutionOverride(base.execution, overrides.execution),
  );
  if (
    base.exports.enabled &&
    ((overrides.execution?.backend ?? base.execution.backend) === "direct" ||
      (overrides.filesystem?.cwdWritable ?? base.filesystem.cwdWritable))
  ) {
    throw new Error(
      "exports.enabled requires a confined backend and filesystem.cwd_writable = false after account overrides",
    );
  }
  return Object.freeze({
    configVersion: 16,
    ...(base.extensionGuidance === undefined ? {} : { extensionGuidance: base.extensionGuidance }),
    ...(base.subagents === undefined ? {} : { subagents: base.subagents }),
    codemode: base.codemode,
    mcp,
    audit: base.audit,
    sessions: base.sessions,
    skills: base.skills,
    exports: base.exports,
    execution: applyExecutionOverride(base.execution, overrides.execution),
    modelAuth: base.modelAuth,
    network: overrides.network ?? base.network,
    filesystem: Object.freeze({ ...base.filesystem, ...overrides.filesystem }),
    environment: base.environment,
    extensions: base.extensions,
    tools: Object.freeze(tools),
  });
}

function applyMcpOverrides(
  base: SandboxConfig["mcp"],
  overrides: AccountOverrides["mcp"],
): SandboxConfig["mcp"] {
  if (overrides === undefined) return base;
  const servers = { ...base.servers };
  for (const [id, override] of Object.entries(overrides.servers)) {
    if (!Object.hasOwn(base.servers, id))
      throw new Error(
        `configuration service returned an override for unavailable MCP server: ${id}`,
      );
    servers[id] = Object.freeze({ ...base.servers[id]!, ...override });
  }
  return Object.freeze({ servers: Object.freeze(servers) });
}

/** A account overlay can change read-tool policies without the bash table that relied on them. */
function assertEffectiveCommandClassPolicies(tools: Readonly<Record<string, ToolPolicy>>): void {
  const issues = commandClassPreconditionIssues(tools, "tools");
  if (issues.length === 0) return;
  const remedies = COMMAND_CLASSES.filter(
    (commandClass) => tools[COMMAND_CLASS_TOOL]?.commandClasses?.[commandClass]?.mode === "allow",
  ).map(
    (commandClass) =>
      `allow ${commandClassAllowRequirements(commandClass).join(", ")} or use a stricter ${COMMAND_CLASS_TOOL}.${commandClass} mode`,
  );
  throw new Error(
    `effective tool policy after account overrides is invalid: ${issues.join("; ")}; ${remedies.join("; ")} in the base configuration or configuration service rules`,
  );
}

function applyExecutionOverride(
  base: ExecutionConfig,
  override?: Pick<ExecutionConfig, "backend">,
): ExecutionConfig {
  const backend = override?.backend ?? base.backend;
  return Object.freeze({ ...base, backend });
}

export function parseAccountOverrides(value: unknown): AccountOverrides {
  if (
    !isRecord(value) ||
    !Object.hasOwn(value, "tools") ||
    !hasAllowedKeys(value, ["execution", "network", "filesystem", "mcp", "tools", "workspace"])
  ) {
    throw invalidResponse();
  }

  let execution: Pick<ExecutionConfig, "backend"> | undefined;
  if (Object.hasOwn(value, "execution")) {
    if (
      !isRecord(value.execution) ||
      !hasExactKeys(value.execution, ["backend"]) ||
      !["bubblewrap", "direct", "seatbelt"].includes(String(value.execution.backend))
    )
      throw invalidResponse();
    execution = Object.freeze({ backend: value.execution.backend as ExecutionConfig["backend"] });
  }
  let filesystem: Pick<FilesystemConfig, "cwdWritable"> | undefined;
  if (Object.hasOwn(value, "filesystem")) {
    if (
      !isRecord(value.filesystem) ||
      !hasExactKeys(value.filesystem, ["cwd_writable"]) ||
      typeof value.filesystem.cwd_writable !== "boolean"
    ) {
      throw invalidResponse();
    }
    filesystem = Object.freeze({ cwdWritable: value.filesystem.cwd_writable });
  }
  let network: NetworkConfig | undefined;
  if (Object.hasOwn(value, "network")) {
    if (
      !isRecord(value.network) ||
      !hasExactKeys(value.network, ["mode"]) ||
      typeof value.network.mode !== "string" ||
      !NETWORK_MODES.includes(value.network.mode as (typeof NETWORK_MODES)[number])
    ) {
      throw invalidResponse();
    }
    network = Object.freeze({ mode: value.network.mode as NetworkConfig["mode"] });
  }

  const mcp = Object.hasOwn(value, "mcp") ? parseMcpOverrides(value.mcp) : undefined;
  const workspace = Object.hasOwn(value, "workspace")
    ? parseWorkspaceOverrides(value.workspace)
    : undefined;

  const tools: Partial<Record<string, SubjectPolicy>> = {};
  if (Object.hasOwn(value, "tools")) {
    if (!isRecord(value.tools) || Object.keys(value.tools).length > 256) {
      throw invalidResponse();
    }
    for (const toolName of Object.keys(value.tools)) {
      if (!validToolName(toolName)) throw invalidResponse();
      tools[toolName] = parseSubjectPolicy(value.tools[toolName], toolName);
    }
  }
  return Object.freeze({
    ...(execution === undefined ? {} : { execution }),
    ...(network === undefined ? {} : { network }),
    ...(filesystem === undefined ? {} : { filesystem }),
    ...(mcp === undefined ? {} : { mcp }),
    ...(workspace === undefined ? {} : { workspace }),
    tools: Object.freeze(tools),
  });
}

export function parseWorkspaceOverrides(
  value: unknown,
): NonNullable<AccountOverrides["workspace"]> {
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    !hasAllowedKeys(value, ["allowed", "default"])
  ) {
    throw invalidResponse();
  }
  const validName = (name: unknown): name is string =>
    typeof name === "string" && /^[a-z][a-z0-9_-]{0,31}$/u.test(name);
  let allowed: readonly string[] | undefined;
  if (Object.hasOwn(value, "allowed")) {
    const names = value.allowed;
    if (!Array.isArray(names) || names.length > 32 || !names.every(validName))
      throw invalidResponse();
    if (names.some((name, index) => index > 0 && names[index - 1]! >= name))
      throw invalidResponse();
    allowed = Object.freeze([...names]);
  }
  let defaultName: string | undefined;
  if (Object.hasOwn(value, "default")) {
    if (!validName(value.default)) throw invalidResponse();
    defaultName = value.default;
  }
  return Object.freeze({
    ...(allowed === undefined ? {} : { allowed }),
    ...(defaultName === undefined ? {} : { default: defaultName }),
  });
}

function parseMcpOverrides(value: unknown): NonNullable<AccountOverrides["mcp"]> {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["servers"]) ||
    !isRecord(value.servers) ||
    Buffer.byteLength(JSON.stringify(value)) > 256 * 1024
  )
    throw invalidResponse();
  const entries = Object.entries(value.servers);
  if (entries.length === 0 || entries.length > 32) throw invalidResponse();
  let totalRules = 0;
  const servers = Object.fromEntries(
    entries.map(([id, server]) => {
      if (
        !/^[a-z][a-z0-9_]{0,31}$/u.test(id) ||
        !isRecord(server) ||
        Object.keys(server).length === 0 ||
        !hasAllowedKeys(server, ["enabled", "policy_layers"])
      )
        throw invalidResponse();
      let enabled: boolean | undefined;
      if (Object.hasOwn(server, "enabled")) {
        if (typeof server.enabled !== "boolean") throw invalidResponse();
        enabled = server.enabled;
      }
      let policyLayers: readonly McpPolicyLayer[] | undefined;
      if (Object.hasOwn(server, "policy_layers")) {
        const layers = server.policy_layers;
        if (!Array.isArray(layers) || layers.length === 0 || layers.length > 256)
          throw invalidResponse();
        const seen = new Set<string>();
        let serverRules = 0;
        policyLayers = Object.freeze(
          layers.map((value) => {
            const layer = parseMcpPolicyLayer(value);
            const key = JSON.stringify(layer);
            // The service emits normalized, deduplicated contributions.
            if (seen.has(key)) throw invalidResponse();
            seen.add(key);
            serverRules += layer.toolRules.length;
            if (serverRules > 256) throw invalidResponse();
            return layer;
          }),
        );
        totalRules += serverRules;
        if (totalRules > 1024) throw invalidResponse();
      }
      return [
        id,
        Object.freeze({
          ...(enabled === undefined ? {} : { enabled }),
          ...(policyLayers === undefined ? {} : { policyLayers }),
        }),
      ];
    }),
  );
  return Object.freeze({ servers: Object.freeze(servers) });
}

function parseMcpPolicyLayer(value: unknown): McpPolicyLayer {
  if (
    !isRecord(value) ||
    !hasAllowedKeys(value, ["default_policy", "tool_rules"]) ||
    !Array.isArray(value.tool_rules) ||
    value.tool_rules.length > 256
  )
    throw invalidResponse();
  const defaultPolicy = Object.hasOwn(value, "default_policy")
    ? parseMcpApprovalPolicy(value.default_policy)
    : undefined;
  if (defaultPolicy === undefined && value.tool_rules.length === 0) throw invalidResponse();
  const patterns = new Set<string>();
  const toolRules: readonly McpApprovalRule[] = Object.freeze(
    value.tool_rules.map((rule: unknown) => {
      if (
        !isRecord(rule) ||
        !hasExactKeys(rule, ["match", "mode", "session_grant"]) ||
        !isMcpToolPattern(rule.match) ||
        patterns.has(rule.match)
      )
        throw invalidResponse();
      patterns.add(rule.match);
      const policy = parseMcpApprovalPolicy({ mode: rule.mode, session_grant: rule.session_grant });
      return Object.freeze({ match: rule.match, ...policy });
    }),
  );
  return Object.freeze({
    ...(defaultPolicy === undefined ? {} : { defaultPolicy }),
    toolRules,
  });
}

function parseMcpApprovalPolicy(value: unknown): McpApprovalPolicy {
  if (!isRecord(value) || !hasExactKeys(value, ["mode", "session_grant"])) throw invalidResponse();
  // This deliberately excludes the ordinary tool parser's Bash command-class fields.
  const policy = parseSubjectPolicy(value, "mcp");
  return Object.freeze({ mode: policy.mode, sessionGrant: policy.sessionGrant });
}

function validToolName(value: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/u.test(value);
}

function parseSubjectPolicy(value: unknown, toolName: string): SubjectPolicy {
  const classes: readonly CommandClass[] = toolName === COMMAND_CLASS_TOOL ? COMMAND_CLASSES : [];
  if (
    !isRecord(value) ||
    !Object.hasOwn(value, "mode") ||
    !Object.hasOwn(value, "session_grant") ||
    !hasAllowedKeys(value, ["mode", "session_grant", ...classes])
  ) {
    throw invalidResponse();
  }
  const mode = value.mode;
  const sessionGrant = value.session_grant;
  if (
    typeof mode !== "string" ||
    !POLICY_MODES.includes(mode as (typeof POLICY_MODES)[number]) ||
    typeof sessionGrant !== "string" ||
    !SESSION_GRANT_POLICIES.includes(sessionGrant as (typeof SESSION_GRANT_POLICIES)[number]) ||
    (mode !== "ask" && sessionGrant === "offer")
  ) {
    throw invalidResponse();
  }
  const policy = {
    mode: mode as SubjectPolicy["mode"],
    sessionGrant: sessionGrant as SubjectPolicy["sessionGrant"],
  };
  const commandClasses: Partial<Record<CommandClass, CommandClassPolicy>> = {};
  for (const commandClass of classes) {
    if (!Object.hasOwn(value, commandClass)) continue;
    const classPolicy = parseCommandClassPolicy(value[commandClass]);
    // The service normalizes merged rules; an unnormalized class policy is a protocol violation.
    if (commandClassPolicyViolation(policy, classPolicy) !== undefined) throw invalidResponse();
    commandClasses[commandClass] = classPolicy;
  }
  return Object.freeze({
    ...policy,
    ...(Object.keys(commandClasses).length === 0
      ? {}
      : { commandClasses: Object.freeze(commandClasses) }),
  });
}

function parseCommandClassPolicy(value: unknown): CommandClassPolicy {
  if (!isRecord(value) || !hasExactKeys(value, ["mode", "session_grant"])) {
    throw invalidResponse();
  }
  if (
    typeof value.mode !== "string" ||
    !COMMAND_CLASS_MODES.includes(value.mode as (typeof COMMAND_CLASS_MODES)[number]) ||
    typeof value.session_grant !== "string" ||
    !SESSION_GRANT_POLICIES.includes(
      value.session_grant as (typeof SESSION_GRANT_POLICIES)[number],
    ) ||
    (value.mode !== "ask" && value.session_grant === "offer")
  ) {
    throw invalidResponse();
  }
  return Object.freeze({
    mode: value.mode as CommandClassPolicy["mode"],
    sessionGrant: value.session_grant as CommandClassPolicy["sessionGrant"],
  });
}

function invalidResponse(): Error {
  return new Error("account_override_invalid");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function hasAllowedKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  const allowedSet = new Set(allowed);
  return Object.keys(value).every((key) => allowedSet.has(key));
}
