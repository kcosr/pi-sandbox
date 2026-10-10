import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { TOOL_NAMES, type BuiltInToolName, type SubjectPolicy } from "./policy/contracts.js";
import {
  NETWORK_MODES,
  PROCESS_LIFETIMES,
  type NetworkMode,
  type ProcessLifetime,
} from "./runtime/contracts.js";

export interface BubblewrapBackendConfig {
  readonly kind: "bubblewrap";
  readonly executable: string;
  readonly runtime: string;
  readonly network: NetworkMode;
  readonly processLifetime: ProcessLifetime;
  readonly cwdWritable: boolean;
  readonly hiddenPaths: readonly string[];
  readonly environment: Readonly<Record<string, string>>;
}
export interface DirectBackendConfig {
  readonly kind: "direct";
  readonly environment: Readonly<Record<string, string>>;
}
export interface SandboxExtensionConfig {
  readonly version: 1;
  readonly mode: "owned";
  readonly backend: BubblewrapBackendConfig | DirectBackendConfig;
  /** Missing names are disabled. CLI visibility cannot expand this ceiling. */
  readonly tools: Readonly<Partial<Record<BuiltInToolName, SubjectPolicy>>>;
  readonly userBash: boolean;
}

function record(value: unknown): asserts value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected configuration object");
}
function keys(value: Record<string, unknown>, required: readonly string[]): void {
  if (Object.keys(value).sort().join(",") !== [...required].sort().join(","))
    throw new Error("Invalid sandbox configuration keys");
}
function absolute(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    /[\0\r\n]/u.test(value)
  )
    throw new Error("Expected normalized absolute sandbox path");
}
function environment(value: unknown): Readonly<Record<string, string>> {
  record(value);
  if (Object.keys(value).length > 256) throw new Error("Too many environment variables");
  let bytes = 0;
  for (const [key, entry] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || typeof entry !== "string" || entry.includes("\0"))
      throw new Error("Invalid sandbox environment");
    bytes += Buffer.byteLength(key) + Buffer.byteLength(entry) + 2;
  }
  if (bytes > 32768) throw new Error("Sandbox environment exceeds 32 KiB");
  return Object.freeze({ ...value } as Record<string, string>);
}
export function parseSandboxConfig(value: unknown): SandboxExtensionConfig {
  record(value);
  keys(value, ["version", "mode", "backend", "tools", "userBash"]);
  if (value.version !== 1 || value.mode !== "owned" || typeof value.userBash !== "boolean")
    throw new Error("Unsupported sandbox configuration");
  record(value.tools);
  const tools: Partial<Record<BuiltInToolName, SubjectPolicy>> = {};
  for (const [name, policy] of Object.entries(value.tools)) {
    if (!TOOL_NAMES.includes(name as BuiltInToolName)) throw new Error("Unknown sandbox tool");
    record(policy);
    keys(policy, ["mode", "sessionGrant"]);
    if (
      !["allow", "ask", "deny", "disabled"].includes(policy.mode as string) ||
      !["never", "offer"].includes(policy.sessionGrant as string)
    )
      throw new Error("Invalid tool policy");
    tools[name as BuiltInToolName] = Object.freeze({ ...policy } as unknown as SubjectPolicy);
  }
  record(value.backend);
  const input = value.backend;
  let backend: SandboxExtensionConfig["backend"];
  if (input.kind === "direct") {
    keys(input, ["kind", "environment"]);
    backend = { kind: "direct", environment: environment(input.environment) };
  } else if (input.kind === "bubblewrap") {
    keys(input, [
      "kind",
      "executable",
      "runtime",
      "network",
      "processLifetime",
      "cwdWritable",
      "hiddenPaths",
      "environment",
    ]);
    absolute(input.executable);
    absolute(input.runtime);
    if (
      !NETWORK_MODES.includes(input.network as NetworkMode) ||
      !PROCESS_LIFETIMES.includes(input.processLifetime as ProcessLifetime) ||
      typeof input.cwdWritable !== "boolean" ||
      !Array.isArray(input.hiddenPaths)
    )
      throw new Error("Invalid Bubblewrap options");
    const hiddenPaths = input.hiddenPaths as unknown[];
    for (const entry of hiddenPaths) absolute(entry);
    backend = {
      kind: "bubblewrap",
      executable: input.executable,
      runtime: input.runtime,
      network: input.network as NetworkMode,
      processLifetime: input.processLifetime as ProcessLifetime,
      cwdWritable: input.cwdWritable,
      hiddenPaths: Object.freeze([...hiddenPaths] as string[]),
      environment: environment(input.environment),
    };
  } else throw new Error("Unsupported sandbox backend");
  return Object.freeze({
    version: 1,
    mode: "owned",
    backend: Object.freeze(backend),
    tools: Object.freeze(tools),
    userBash: value.userBash,
  });
}
export async function readSandboxConfig(file: string): Promise<SandboxExtensionConfig> {
  absolute(file);
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Sandbox config must be a private owned regular file under 64 KiB");
    // Bound the read as well as the initial stat in case the file changes.
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > 65536) throw new Error("Sandbox config exceeds 64 KiB");
    return parseSandboxConfig(JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown);
  } finally {
    await handle.close();
  }
}
