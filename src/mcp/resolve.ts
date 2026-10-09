import { access, constants } from "node:fs/promises";
import {
  expandAccountValue,
  expandMcpUrl,
  type AccountIdentity,
  type McpServerConfig,
  type SandboxConfig,
} from "../domain/index.js";
import { isMcpHeaderValue } from "../config/mcp.js";

export interface ResolvedMcpServer {
  readonly policy: McpServerConfig;
  readonly status:
    | "ready"
    | "disabled"
    | "executable-unavailable"
    | "credentials-unavailable"
    | "configuration-value-unavailable";
  readonly url?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly environment?: Readonly<Record<string, string>>;
}

class AccountResolutionError extends Error {
  public constructor() {
    super("Unable to resolve the invoking account identity for MCP configuration");
  }
}

function checkedMap(
  values: Record<string, string>,
  headers: boolean,
): Readonly<Record<string, string>> {
  let bytes = 0;
  for (const [name, value] of Object.entries(values)) {
    const size = Buffer.byteLength(value);
    if (size > 16 * 1024 || value.includes("\0") || (headers && !isMcpHeaderValue(value))) {
      throw new Error("Invalid resolved MCP value");
    }
    bytes += Buffer.byteLength(name) + size;
  }
  if (bytes > 64 * 1024) throw new Error("Resolved MCP values exceed the limit");
  return Object.freeze(values);
}

function references(
  mapping: Readonly<Record<string, string>>,
  snapshot: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(mapping).map(([name, reference]) => {
      const value = Object.hasOwn(snapshot, reference) ? snapshot[reference] : undefined;
      if (value === undefined || value === "") throw new Error("Missing MCP credential");
      return [name, value];
    }),
  );
}

/** Capture only selected references once. No server can read the full host snapshot. */
export async function resolveMcpServers(
  config: SandboxConfig["mcp"],
  environment: NodeJS.ProcessEnv,
  getIdentity: () => AccountIdentity,
  checkExecutable: (path: string) => Promise<void> = (path) => access(path, constants.X_OK),
): Promise<readonly ResolvedMcpServer[]> {
  const snapshot = Object.freeze({ ...environment });
  let identity: AccountIdentity | undefined;
  const account = (): AccountIdentity => {
    if (identity !== undefined) return identity;
    try {
      identity = getIdentity();
    } catch {
      throw new AccountResolutionError();
    }
    return identity;
  };
  const resolved: ResolvedMcpServer[] = [];
  for (const policy of Object.values(config.servers)) {
    if (!policy.enabled) {
      resolved.push(Object.freeze({ policy, status: "disabled" }));
      continue;
    }
    if (policy.transport === "stdio") {
      try {
        await checkExecutable(policy.command);
      } catch {
        // Runtime availability affects this server only. Do not resolve or project
        // credentials for a process that cannot start, or expose host error details.
        resolved.push(Object.freeze({ policy, status: "executable-unavailable" }));
        continue;
      }
    }
    let values: Record<string, string>;
    try {
      values = references(
        policy.transport === "http" ? policy.headersFromEnv : policy.envFromEnv,
        snapshot,
      );
      checkedMap(values, policy.transport === "http");
    } catch {
      resolved.push(Object.freeze({ policy, status: "credentials-unavailable" }));
      continue;
    }
    let url: string | undefined;
    let literals: Readonly<Record<string, string>>;
    try {
      if (policy.transport === "http") {
        url = expandMcpUrl(policy.url, account);
        literals = checkedMap({ ...policy.headers }, true);
      } else {
        const user = account();
        const locale = process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8";
        const baseline = {
          PATH: "/usr/local/bin:/usr/bin:/bin",
          LANG: locale,
          LC_ALL: locale,
          HOME: user.homeDirectory,
          USER: user.username,
          LOGNAME: user.username,
          TMPDIR: "/tmp",
        };
        const explicit = Object.fromEntries(
          Object.entries(policy.env).map(([name, value]) => [
            name,
            expandAccountValue(value, account),
          ]),
        );
        literals = checkedMap({ ...baseline, ...explicit }, false);
      }
    } catch (error) {
      if (error instanceof AccountResolutionError) throw error;
      resolved.push(Object.freeze({ policy, status: "configuration-value-unavailable" }));
      continue;
    }
    let combined: Readonly<Record<string, string>>;
    try {
      combined = checkedMap({ ...literals, ...values }, policy.transport === "http");
    } catch {
      // Literals were checked separately: only adding per-account references can
      // overflow this combined limit. Do not mislabel it as administrative syntax.
      resolved.push(Object.freeze({ policy, status: "credentials-unavailable" }));
      continue;
    }
    resolved.push(
      Object.freeze({
        policy,
        status: "ready",
        ...(policy.transport === "http"
          ? { url: url!, headers: combined }
          : { environment: combined }),
      }),
    );
  }
  return Object.freeze(resolved);
}
