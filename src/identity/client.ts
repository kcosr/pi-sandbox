import { createConnection } from "node:net";

import {
  EXECUTION_BACKENDS,
  POLICY_MODES,
  NETWORK_MODES,
  SESSION_GRANT_POLICIES,
  IDENTITY_BROKER_SOCKET_PATH,
  emptyManagedEnvironment,
  isNormalizedAbsoluteFilePath,
  parseManagedEnvironment,
  type ExecutionConfig,
  type FilesystemConfig,
  type IdentityConfig,
  type ManagedEnvironment,
  type NetworkConfig,
  type SandboxConfig,
  type SubjectPolicy,
  type ToolPolicy,
  type IdentityOverrides,
} from "../domain/index.js";

export const IDENTITY_BROKER_PROTOCOL_VERSION = 6;
export const IDENTITY_BROKER_TIMEOUT_MS = 10_000;
export const MAXIMUM_IDENTITY_RESPONSE_BYTES = 512 * 1024;

export interface BrokerIdentity {
  readonly environment: ManagedEnvironment;
  readonly overrides: IdentityOverrides;
}

interface BrokerSuccessResponse {
  readonly version: 6;
  readonly status: "ok";
  readonly environment: ManagedEnvironment;
  readonly overrides: IdentityOverrides;
}

interface BrokerErrorResponse {
  readonly version: 6;
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
      version: 6,
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

export function applyIdentityOverrides(
  base: SandboxConfig,
  overrides: IdentityOverrides,
): SandboxConfig {
  const availableTools = new Set(Object.keys(base.tools));
  for (const toolName of Object.keys(overrides.tools)) {
    if (!availableTools.has(toolName)) {
      throw new Error(`identity broker returned an override for unavailable tool: ${toolName}`);
    }
  }
  const tools = Object.fromEntries(
    Object.keys(base.tools).map((toolName) => [
      toolName,
      overrides.tools[toolName] === undefined
        ? base.tools[toolName]
        : Object.freeze({ ...overrides.tools[toolName], audit: base.tools[toolName]!.audit }),
    ]),
  ) as Record<string, ToolPolicy>;
  return Object.freeze({
    configVersion: 8,
    audit: base.audit,
    sessions: base.sessions,
    modelsFile: overrides.modelsFile ?? base.modelsFile,
    execution: overrides.execution ?? base.execution,
    identity: base.identity,
    network: overrides.network ?? base.network,
    filesystem: Object.freeze({ ...base.filesystem, ...overrides.filesystem }),
    environment: base.environment,
    extensions: base.extensions,
    tools: Object.freeze(tools),
  });
}

function parseIdentityOverrides(value: unknown): IdentityOverrides {
  if (
    !isRecord(value) ||
    !hasAllowedKeys(value, ["models_file", "execution", "network", "filesystem", "tools"])
  ) {
    throw invalidResponse();
  }

  let execution: ExecutionConfig | undefined;
  if (Object.hasOwn(value, "execution")) {
    if (
      !isRecord(value.execution) ||
      !hasExactKeys(value.execution, ["backend"]) ||
      typeof value.execution.backend !== "string" ||
      !EXECUTION_BACKENDS.includes(value.execution.backend as (typeof EXECUTION_BACKENDS)[number])
    ) {
      throw invalidResponse();
    }
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

  const tools: Partial<Record<string, SubjectPolicy>> = {};
  if (Object.hasOwn(value, "tools")) {
    if (!isRecord(value.tools) || Object.keys(value.tools).length > 256) {
      throw invalidResponse();
    }
    for (const toolName of Object.keys(value.tools)) {
      if (!validToolName(toolName)) throw invalidResponse();
      tools[toolName] = parseSubjectPolicy(value.tools[toolName]);
    }
  }
  return Object.freeze({
    ...(modelsFile === undefined ? {} : { modelsFile }),
    ...(execution === undefined ? {} : { execution }),
    ...(network === undefined ? {} : { network }),
    ...(filesystem === undefined ? {} : { filesystem }),
    tools: Object.freeze(tools),
  });
}

function parseBrokerEnvironment(value: unknown): ManagedEnvironment {
  try {
    return parseManagedEnvironment(value);
  } catch {
    throw invalidResponse();
  }
}

function validToolName(value: string): boolean {
  return /^[a-z][a-z0-9_]{0,63}$/u.test(value);
}

function parseSubjectPolicy(value: unknown): SubjectPolicy {
  if (!isRecord(value) || !hasExactKeys(value, ["mode", "session_grant"])) {
    throw invalidResponse();
  }
  if (
    typeof value.mode !== "string" ||
    !POLICY_MODES.includes(value.mode as (typeof POLICY_MODES)[number]) ||
    typeof value.session_grant !== "string" ||
    !SESSION_GRANT_POLICIES.includes(
      value.session_grant as (typeof SESSION_GRANT_POLICIES)[number],
    ) ||
    (value.mode !== "ask" && value.session_grant === "offer")
  ) {
    throw invalidResponse();
  }
  return Object.freeze({
    mode: value.mode as SubjectPolicy["mode"],
    sessionGrant: value.session_grant as SubjectPolicy["sessionGrant"],
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
