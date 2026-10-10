import {
  POLICY_MODES,
  SESSION_GRANT_POLICIES,
  isNormalizedAbsoluteFilePath,
  isManagedEnvironmentName,
  validateAccountTemplate,
  validateMcpUrl,
  type CodeModeConfig,
  type McpConfig,
  type McpServerConfig,
  type ToolPolicy,
} from "../domain/index.js";

type RecordValue = Record<string, unknown>;
function table(value: unknown, path: string): RecordValue {
  if (typeof value !== "object" || value === null || Array.isArray(value) || value instanceof Date)
    throw new Error(`${path} must be a table`);
  return value as RecordValue;
}
function keys(value: RecordValue, required: string[], optional: string[], path: string): void {
  for (const key of required)
    if (!Object.hasOwn(value, key)) throw new Error(`${path}.${key} is required`);
  for (const key of Object.keys(value))
    if (![...required, ...optional].includes(key))
      throw new Error(`${path}.${key} is not a recognized field`);
}
function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be a boolean`);
  return value;
}
function choice<T extends string>(value: unknown, allowed: readonly T[], path: string): T {
  if (typeof value !== "string" || !allowed.includes(value as T))
    throw new Error(`${path} must be one of: ${allowed.join(", ")}`);
  return value as T;
}
function timeout(value: unknown, fallback: number, path: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1000 || value > 3600000)
    throw new Error(`${path} must be an integer between 1000 and 3600000`);
  return value;
}
function policy(value: unknown, path: string, rule = false): ToolPolicy {
  const entry = table(value, path);
  keys(entry, ["mode", "session_grant", "audit", ...(rule ? ["match"] : [])], [], path);
  const mode = choice(entry.mode, POLICY_MODES, `${path}.mode`);
  const sessionGrant = choice(entry.session_grant, SESSION_GRANT_POLICIES, `${path}.session_grant`);
  if (mode !== "ask" && sessionGrant === "offer")
    throw new Error(`${path}.session_grant may be offer only for ask`);
  return Object.freeze({ mode, sessionGrant, audit: boolean(entry.audit, `${path}.audit`) });
}
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
const TRANSPORT_HEADERS = new Set([
  "host",
  "content-length",
  "connection",
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "transfer-encoding",
  "upgrade",
  "te",
  "trailer",
  "keep-alive",
]);
export function isMcpHeaderName(name: string): boolean {
  return (
    HEADER_NAME.test(name) &&
    Buffer.byteLength(name) <= 128 &&
    !TRANSPORT_HEADERS.has(name.toLowerCase())
  );
}
export function isMcpHeaderValue(value: string): boolean {
  return !/[^\x20-\x7e\xa0-\xff]/u.test(value) && Buffer.byteLength(value) <= 16 * 1024;
}
function valueMap(
  value: unknown,
  path: string,
  headers: boolean,
  references: boolean,
): Readonly<Record<string, string>> {
  if (value === undefined) return Object.freeze({});
  const entries = Object.entries(table(value, path));
  if (entries.length > 64) throw new Error(`${path} exceeds 64 entries`);
  const names = new Set<string>();
  let bytes = 0;
  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [name, entry] of entries) {
    const normalized = headers ? name.toLowerCase() : name;
    if (
      names.has(normalized) ||
      !(headers ? isMcpHeaderName(name) : isManagedEnvironmentName(name))
    )
      throw new Error(`${path} contains an invalid or duplicate destination name`);
    names.add(normalized);
    if (typeof entry !== "string" || entry.includes("\0") || Buffer.byteLength(entry) > 16 * 1024)
      throw new Error(`${path} contains an invalid value`);
    if (references && !isManagedEnvironmentName(entry))
      throw new Error(`${path} contains an invalid environment reference`);
    if (!references && headers && !isMcpHeaderValue(entry))
      throw new Error(`${path} contains an invalid header value`);
    if (!references && !headers) validateAccountTemplate(entry);
    bytes += Buffer.byteLength(name) + Buffer.byteLength(entry);
    result[name] = entry;
  }
  if (bytes > 64 * 1024) throw new Error(`${path} exceeds 64 KiB`);
  return Object.freeze(result);
}
function disjoint(
  a: Readonly<Record<string, string>>,
  b: Readonly<Record<string, string>>,
  headers: boolean,
  path: string,
): void {
  const normalize = (name: string): string => (headers ? name.toLowerCase() : name);
  const names = new Set(Object.keys(a).map(normalize));
  if (Object.keys(b).some((name) => names.has(normalize(name))))
    throw new Error(`${path} literal and referenced destinations must be disjoint`);
}
export function parseCodeModeConfig(value: unknown): CodeModeConfig {
  const entry = table(value, "config.codemode");
  keys(entry, ["enabled"], ["timeout_ms"], "config.codemode");
  return Object.freeze({
    enabled: boolean(entry.enabled, "config.codemode.enabled"),
    timeoutMs: timeout(entry.timeout_ms, 300000, "config.codemode.timeout_ms"),
  });
}
export function parseMcpConfig(value: unknown, codemode: CodeModeConfig | undefined): McpConfig {
  const entry = table(value, "config.mcp");
  keys(entry, ["servers"], [], "config.mcp");
  const servers = table(entry.servers, "config.mcp.servers");
  if (Object.keys(servers).length > 32) throw new Error("config.mcp.servers exceeds 32 servers");
  if (Buffer.byteLength(JSON.stringify(entry)) > 256 * 1024)
    throw new Error("config.mcp exceeds 256 KiB");
  const result: Record<string, McpServerConfig> = {};
  for (const [id, raw] of Object.entries(servers)) {
    if (!/^[a-z][a-z0-9_]{0,31}$/u.test(id))
      throw new Error("config.mcp.servers contains an invalid identifier");
    const path = `config.mcp.servers.${id}`;
    const server = table(raw, path);
    const transport = choice(server.transport, ["http", "stdio"], `${path}.transport`);
    keys(
      server,
      [
        "enabled",
        "transport",
        "exposure",
        "default_policy",
        ...(transport === "http" ? ["url"] : ["command"]),
      ],
      [
        "timeout_ms",
        "tool_rules",
        ...(transport === "http"
          ? ["headers", "headers_from_env"]
          : ["args", "env", "env_from_env"]),
      ],
      path,
    );
    const enabled = boolean(server.enabled, `${path}.enabled`);
    const exposure = choice(server.exposure, ["direct", "codemode"], `${path}.exposure`);
    if (enabled && exposure === "codemode" && !codemode?.enabled)
      throw new Error(`${path}.exposure requires codemode.enabled`);
    const defaultPolicy = policy(server.default_policy, `${path}.default_policy`);
    const rawRules = server.tool_rules ?? [];
    if (!Array.isArray(rawRules) || rawRules.length > 256)
      throw new Error(`${path}.tool_rules must contain at most 256 rules`);
    const patterns = new Set<string>();
    const toolRules = Object.freeze(
      rawRules.map((rawRule, index) => {
        const rulePath = `${path}.tool_rules[${index}]`;
        const rule = table(rawRule, rulePath);
        if (
          typeof rule.match !== "string" ||
          rule.match.length === 0 ||
          Buffer.byteLength(rule.match) > 128 ||
          /[\p{Cc}\s?[\]{}\\]/u.test(rule.match) ||
          patterns.has(rule.match)
        )
          throw new Error(
            `${rulePath}.match must be a unique nonempty literal/* pattern of at most 128 bytes`,
          );
        patterns.add(rule.match);
        return Object.freeze({ match: rule.match, ...policy(rule, rulePath, true) });
      }),
    );
    const common = {
      id,
      enabled,
      exposure,
      defaultPolicy,
      toolRules,
      timeoutMs: timeout(server.timeout_ms, 60000, `${path}.timeout_ms`),
    };
    if (transport === "http") {
      if (typeof server.url !== "string") throw new Error(`${path}.url must be a literal URL`);
      validateMcpUrl(server.url);
      const headers = valueMap(server.headers, `${path}.headers`, true, false);
      const headersFromEnv = valueMap(
        server.headers_from_env,
        `${path}.headers_from_env`,
        true,
        true,
      );
      disjoint(headers, headersFromEnv, true, path);
      result[id] = Object.freeze({
        ...common,
        transport,
        url: server.url,
        headers,
        headersFromEnv,
      });
    } else {
      if (!isNormalizedAbsoluteFilePath(server.command))
        throw new Error(`${path}.command must be a normalized absolute file path`);
      const args = server.args ?? [];
      if (
        !Array.isArray(args) ||
        args.length + 1 > 128 ||
        args.some((arg) => typeof arg !== "string" || /[\p{Cc}]/u.test(arg)) ||
        Buffer.byteLength(server.command) +
          (args as string[]).reduce((n, arg) => n + Buffer.byteLength(arg), 0) >
          64 * 1024
      )
        throw new Error(
          `${path}.args must be literal strings within the 128-entry/64-KiB command limit`,
        );
      const env = valueMap(server.env, `${path}.env`, false, false);
      const envFromEnv = valueMap(server.env_from_env, `${path}.env_from_env`, false, true);
      disjoint(env, envFromEnv, false, path);
      result[id] = Object.freeze({
        ...common,
        transport,
        command: server.command,
        args: Object.freeze(args),
        env,
        envFromEnv,
      });
    }
  }
  return Object.freeze({ servers: Object.freeze(result) });
}
