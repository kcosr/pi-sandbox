import { createConnection } from "node:net";
import { assertMcpCodeModeExposure } from "../config/mcp.js";
import { administrativeConfigIssues } from "../config/workspace-mode.js";

import {
  COMMAND_CLASS_MODES,
  POLICY_MODES,
  NETWORK_MODES,
  SESSION_GRANT_POLICIES,
  IDENTITY_BROKER_SOCKET_PATH,
  emptyManagedEnvironment,
  isNormalizedAbsoluteFilePath,
  parseBrokerManagedEnvironment,
  type AuthoredPiEnvironmentValue,
  type ResolvedPiEnvironmentValue,
  isMcpToolPattern,
  type McpApprovalPolicy,
  type McpApprovalRule,
  type McpPolicyLayer,
  type ExecutionConfig,
  TOOL_NAMES,
  WORKSPACE_MODES,
  type WorkspaceMode,
  type WorkspaceToolPolicy,
  type WorkspaceToolOverride,
  type WorkspaceApprovalPolicy,
  type IdentityConfig,
  type ManagedEnvironment,
  type NetworkConfig,
  type AdministrativeConfig,
  type CommandClassPolicy,
  type SubjectPolicy,
  type IdentityOverrides,
} from "../domain/index.js";
import { COMMAND_CLASSES, type CommandClass } from "../permissions/bash/contracts.js";
import { COMMAND_CLASS_TOOL, commandClassPolicyViolation } from "../permissions/command-classes.js";

export const IDENTITY_BROKER_PROTOCOL_VERSION = 11;
export const IDENTITY_BROKER_TIMEOUT_MS = 10_000;
export const MAXIMUM_IDENTITY_RESPONSE_BYTES = 512 * 1024;

export interface BrokerIdentity {
  readonly environment: ManagedEnvironment<ResolvedPiEnvironmentValue>;
  readonly overrides: IdentityOverrides;
}

interface BrokerSuccessResponse {
  readonly version: 11;
  readonly status: "ok";
  readonly environment: ManagedEnvironment<ResolvedPiEnvironmentValue>;
  readonly overrides: IdentityOverrides;
}

interface BrokerErrorResponse {
  readonly version: 11;
  readonly status: "error";
  readonly code: "identity_store_unavailable" | "protocol_error";
}

type BrokerResponse = BrokerSuccessResponse | BrokerErrorResponse;
export type BrokerIdentityResolver = (socketPath: string) => Promise<BrokerIdentity>;

export async function configureManagedIdentity(
  identity: IdentityConfig,
  resolveIdentity: BrokerIdentityResolver = resolveBrokerIdentity,
): Promise<BrokerIdentity> {
  if (identity.mode === "disabled") return emptyBrokerIdentity();
  return resolveIdentity(IDENTITY_BROKER_SOCKET_PATH);
}

export function resolveBrokerIdentity(socketPath: string): Promise<BrokerIdentity> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ path: socketPath, allowHalfOpen: true });
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    let settled = false;

    const finish = (error?: Error, identity?: BrokerIdentity): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      socket.destroy();
      if (error !== undefined) reject(error);
      else if (identity !== undefined) resolve(identity);
      else reject(new Error("identity broker returned no identity"));
    };

    const deadline = setTimeout(
      () => finish(new Error("identity broker timed out")),
      IDENTITY_BROKER_TIMEOUT_MS,
    );
    socket.once("connect", () => {
      socket.write(
        `${JSON.stringify({ version: IDENTITY_BROKER_PROTOCOL_VERSION, operation: "resolve-identity" })}\n`,
      );
    });
    socket.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAXIMUM_IDENTITY_RESPONSE_BYTES) {
        finish(new Error("identity broker returned an oversized response"));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    socket.once("error", () => finish(new Error("identity broker is unavailable")));
    socket.once("end", () => {
      if (settled) return;
      if (totalBytes === 0) {
        finish(new Error("identity broker closed without a response"));
        return;
      }
      try {
        const response = parseBrokerResponse(Buffer.concat(chunks).toString("utf8"));
        if (response.status === "ok") {
          finish(undefined, {
            environment: response.environment,
            overrides: response.overrides,
          });
        } else {
          finish(new Error(errorMessage(response.code)));
        }
      } catch {
        finish(new Error("identity broker returned an invalid response"));
      }
    });
    socket.once("close", () => {
      if (!settled) finish(new Error("identity broker closed without a response"));
    });
  });
}

export function parseBrokerResponse(source: string): BrokerResponse {
  if (Buffer.byteLength(source) > MAXIMUM_IDENTITY_RESPONSE_BYTES) throw invalidResponse();
  let value: unknown;
  try {
    assertNoDuplicateObjectKeys(source);
    value = JSON.parse(source);
  } catch {
    throw invalidResponse();
  }
  if (!isRecord(value) || value.version !== IDENTITY_BROKER_PROTOCOL_VERSION) {
    throw invalidResponse();
  }
  if (value.status === "ok") {
    if (!hasExactKeys(value, ["version", "status", "environment", "overrides"])) {
      throw invalidResponse();
    }
    return Object.freeze({
      version: 11,
      status: "ok",
      environment: parseBrokerEnvironment(value.environment),
      overrides: parseIdentityOverrides(value.overrides),
    });
  }
  if (
    value.status !== "error" ||
    !hasExactKeys(value, ["version", "status", "code"]) ||
    typeof value.code !== "string" ||
    !["identity_store_unavailable", "protocol_error"].includes(value.code)
  ) {
    throw invalidResponse();
  }
  return value as unknown as BrokerErrorResponse;
}

export function applyIdentityOverrides<PiValue extends AuthoredPiEnvironmentValue>(
  base: AdministrativeConfig<PiValue>,
  overrides: IdentityOverrides,
): AdministrativeConfig<PiValue> {
  const availableTools = new Set(Object.keys(base.tools));
  for (const toolName of Object.keys(overrides.tools)) {
    if (!availableTools.has(toolName)) {
      throw new Error(`identity broker returned an override for unavailable tool: ${toolName}`);
    }
  }
  const tools = Object.fromEntries(
    Object.keys(base.tools).map((toolName) => {
      const original = base.tools[toolName]!;
      const override = overrides.tools[toolName];
      if (override === undefined) return [toolName, original];
      if ((TOOL_NAMES as readonly string[]).includes(toolName)) {
        const workspace = original as WorkspaceToolPolicy;
        const patch = override as WorkspaceToolOverride;
        return [
          toolName,
          Object.freeze({
            enabled: patch.enabled ?? workspace.enabled,
            audit: workspace.audit,
            readOnly: patch.readOnly ?? workspace.readOnly,
            readWrite: patch.readWrite ?? workspace.readWrite,
          }),
        ];
      }
      return [toolName, Object.freeze({ ...(override as SubjectPolicy), audit: original.audit })];
    }),
  );
  const mcp = applyMcpOverrides(base.mcp, overrides.mcp);
  assertMcpCodeModeExposure(mcp, base.codemode);
  const effective = Object.freeze({
    configVersion: 14 as const,
    codemode: base.codemode,
    mcp,
    audit: base.audit,
    sessions: base.sessions,
    modelsFile: overrides.modelsFile ?? base.modelsFile,
    execution: applyExecutionOverride(base.execution, overrides.execution),
    identity: base.identity,
    network: overrides.network ?? base.network,
    filesystem: Object.freeze({ ...base.filesystem, ...overrides.filesystem }),
    environment: base.environment,
    extensions: base.extensions,
    tools: Object.freeze(tools),
  });
  const issues = administrativeConfigIssues(effective);
  if (issues.length > 0)
    throw new Error(
      `effective administrative policy after identity overrides is invalid: ${issues.join("; ")}; update the base configuration or identity broker rules`,
    );
  return effective;
}

function applyMcpOverrides(
  base: AdministrativeConfig["mcp"],
  overrides: IdentityOverrides["mcp"],
): AdministrativeConfig["mcp"] {
  if (overrides === undefined) return base;
  const servers = { ...base.servers };
  for (const [id, override] of Object.entries(overrides.servers)) {
    if (!Object.hasOwn(base.servers, id))
      throw new Error(`identity broker returned an override for unavailable MCP server: ${id}`);
    servers[id] = Object.freeze({ ...base.servers[id]!, ...override });
  }
  return Object.freeze({ servers: Object.freeze(servers) });
}

function applyExecutionOverride(
  base: ExecutionConfig,
  override?: Pick<ExecutionConfig, "backend">,
): ExecutionConfig {
  const backend = override?.backend ?? base.backend;
  return Object.freeze({ ...base, backend });
}

function parseIdentityOverrides(value: unknown): IdentityOverrides {
  if (
    !isRecord(value) ||
    !hasAllowedKeys(value, ["models_file", "execution", "network", "filesystem", "mcp", "tools"])
  ) {
    throw invalidResponse();
  }

  let execution: Pick<ExecutionConfig, "backend"> | undefined;
  if (Object.hasOwn(value, "execution")) {
    if (
      !isRecord(value.execution) ||
      !hasExactKeys(value.execution, ["backend"]) ||
      (value.execution.backend !== "bubblewrap" && value.execution.backend !== "direct")
    )
      throw invalidResponse();
    execution = Object.freeze({ backend: value.execution.backend });
  }
  let filesystem: IdentityOverrides["filesystem"];
  if (Object.hasOwn(value, "filesystem")) {
    if (
      !isRecord(value.filesystem) ||
      Object.keys(value.filesystem).length === 0 ||
      !hasAllowedKeys(value.filesystem, ["cwd_default", "cwd_allowed"])
    )
      throw invalidResponse();
    let cwdDefault: WorkspaceMode | undefined;
    let cwdAllowed: readonly WorkspaceMode[] | undefined;
    if (Object.hasOwn(value.filesystem, "cwd_default")) {
      const mode = value.filesystem.cwd_default;
      if (typeof mode !== "string" || !(WORKSPACE_MODES as readonly string[]).includes(mode))
        throw invalidResponse();
      cwdDefault = mode as WorkspaceMode;
    }
    if (Object.hasOwn(value.filesystem, "cwd_allowed")) {
      const modes = value.filesystem.cwd_allowed;
      if (
        !Array.isArray(modes) ||
        modes.length === 0 ||
        new Set(modes).size !== modes.length ||
        !modes.every(
          (mode) =>
            typeof mode === "string" && (WORKSPACE_MODES as readonly string[]).includes(mode),
        )
      )
        throw invalidResponse();
      cwdAllowed = Object.freeze([...(modes as WorkspaceMode[])]);
    }
    filesystem = Object.freeze({
      ...(cwdDefault === undefined ? {} : { cwdDefault }),
      ...(cwdAllowed === undefined ? {} : { cwdAllowed }),
    });
  }
  let modelsFile: string | undefined;
  if (Object.hasOwn(value, "models_file")) {
    if (!isNormalizedAbsoluteFilePath(value.models_file)) throw invalidResponse();
    modelsFile = value.models_file;
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

  const tools: Partial<Record<string, SubjectPolicy | WorkspaceToolOverride>> = {};
  if (Object.hasOwn(value, "tools")) {
    if (!isRecord(value.tools) || Object.keys(value.tools).length > 256) {
      throw invalidResponse();
    }
    for (const toolName of Object.keys(value.tools)) {
      if (!validToolName(toolName)) throw invalidResponse();
      tools[toolName] = (TOOL_NAMES as readonly string[]).includes(toolName)
        ? parseWorkspaceToolOverride(value.tools[toolName], toolName)
        : parseSubjectPolicy(value.tools[toolName], toolName);
    }
  }
  return Object.freeze({
    ...(modelsFile === undefined ? {} : { modelsFile }),
    ...(execution === undefined ? {} : { execution }),
    ...(network === undefined ? {} : { network }),
    ...(filesystem === undefined ? {} : { filesystem }),
    ...(mcp === undefined ? {} : { mcp }),
    tools: Object.freeze(tools),
  });
}

function parseMcpOverrides(value: unknown): NonNullable<IdentityOverrides["mcp"]> {
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
            // The broker emits normalized, deduplicated contributions.
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

function parseBrokerEnvironment(value: unknown): ManagedEnvironment<ResolvedPiEnvironmentValue> {
  try {
    return parseBrokerManagedEnvironment(value);
  } catch {
    throw invalidResponse();
  }
}

function validToolName(value: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/u.test(value);
}

function parseWorkspaceToolOverride(value: unknown, toolName: string): WorkspaceToolOverride {
  if (
    !isRecord(value) ||
    Object.keys(value).length === 0 ||
    !hasAllowedKeys(value, ["enabled", "read_only", "read_write"])
  )
    throw invalidResponse();
  let enabled: boolean | undefined;
  if (Object.hasOwn(value, "enabled")) {
    if (typeof value.enabled !== "boolean") throw invalidResponse();
    enabled = value.enabled;
  }
  const branch = (key: string): WorkspaceApprovalPolicy | undefined => {
    if (!Object.hasOwn(value, key)) return undefined;
    const policy = parseSubjectPolicy(value[key], toolName);
    if (policy.mode === "disabled") throw invalidResponse();
    return policy as WorkspaceApprovalPolicy;
  };
  const readOnly = branch("read_only");
  const readWrite = branch("read_write");
  return Object.freeze({
    ...(enabled === undefined ? {} : { enabled }),
    ...(readOnly === undefined ? {} : { readOnly }),
    ...(readWrite === undefined ? {} : { readWrite }),
  });
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
    // The broker normalizes merged rules; an unnormalized class policy is a protocol violation.
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

function emptyBrokerIdentity(): BrokerIdentity {
  return Object.freeze({
    environment: emptyManagedEnvironment(),
    overrides: Object.freeze({ tools: Object.freeze({}) }),
  });
}

function errorMessage(code: BrokerErrorResponse["code"]): string {
  switch (code) {
    case "identity_store_unavailable":
      return "identity broker identity overrides are unavailable";
    case "protocol_error":
      return "identity broker rejected the request";
  }
}

function invalidResponse(): Error {
  return new Error("identity_broker_response_invalid");
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

function assertNoDuplicateObjectKeys(source: string): void {
  let offset = 0;

  const skipWhitespace = (): void => {
    while (/\s/u.test(source[offset] ?? "")) offset += 1;
  };

  const parseString = (): string => {
    const start = offset;
    if (source[offset] !== '"') throw invalidResponse();
    offset += 1;
    while (offset < source.length) {
      const character = source[offset];
      if (character === '"') {
        offset += 1;
        return JSON.parse(source.slice(start, offset)) as string;
      }
      if (character === "\\") {
        offset += source[offset + 1] === "u" ? 6 : 2;
      } else {
        offset += 1;
      }
    }
    throw invalidResponse();
  };

  const parseValue = (): void => {
    skipWhitespace();
    const character = source[offset];
    if (character === "{") {
      parseObject();
      return;
    }
    if (character === "[") {
      parseArray();
      return;
    }
    if (character === '"') {
      parseString();
      return;
    }
    const start = offset;
    while (offset < source.length && !",]}".includes(source[offset] ?? "")) offset += 1;
    if (source.slice(start, offset).trim().length === 0) throw invalidResponse();
  };

  const parseObject = (): void => {
    offset += 1;
    skipWhitespace();
    const keys = new Set<string>();
    if (source[offset] === "}") {
      offset += 1;
      return;
    }
    while (offset < source.length) {
      skipWhitespace();
      const key = parseString();
      if (keys.has(key)) throw invalidResponse();
      keys.add(key);
      skipWhitespace();
      if (source[offset] !== ":") throw invalidResponse();
      offset += 1;
      parseValue();
      skipWhitespace();
      if (source[offset] === "}") {
        offset += 1;
        return;
      }
      if (source[offset] !== ",") throw invalidResponse();
      offset += 1;
    }
    throw invalidResponse();
  };

  const parseArray = (): void => {
    offset += 1;
    skipWhitespace();
    if (source[offset] === "]") {
      offset += 1;
      return;
    }
    while (offset < source.length) {
      parseValue();
      skipWhitespace();
      if (source[offset] === "]") {
        offset += 1;
        return;
      }
      if (source[offset] !== ",") throw invalidResponse();
      offset += 1;
    }
    throw invalidResponse();
  };

  parseValue();
  skipWhitespace();
  if (offset !== source.length) throw invalidResponse();
}
