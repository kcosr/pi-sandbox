import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { validateSmolvmResources, type SmolvmResources } from "./runtime/smolvm/options.js";
import { smolvmEnvironment } from "./runtime/smolvm/request.js";
import { validateOciAttachment } from "./runtime/smolvm/oci/transport.js";
import type { SmolvmOciAttachment } from "./runtime/smolvm/oci/types.js";
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
export interface SmolvmBackendConfig {
  readonly kind: "smolvm";
  readonly executable: string;
  readonly image: string;
  readonly imageSha256: string;
  readonly stateDirectory: string;
  readonly resources: SmolvmResources;
  readonly cwdWritable: boolean;
  readonly environment: Readonly<Record<string, string>>;
}
interface CommonConfig {
  readonly version: 4;
  readonly userBash: boolean;
}
export interface OwnedSandboxConfig extends CommonConfig {
  readonly mode: "owned";
  readonly backend: BubblewrapBackendConfig | DirectBackendConfig | SmolvmBackendConfig;
}
export interface AttachedSandboxConfig extends CommonConfig {
  readonly mode: "attached";
  readonly attachment: SmolvmOciAttachment;
}
export type SandboxExtensionConfig = OwnedSandboxConfig | AttachedSandboxConfig;

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
  keys(value, [
    "version",
    "mode",
    value.mode === "attached" ? "attachment" : "backend",
    "userBash",
  ]);
  if (
    value.version !== 4 ||
    !["owned", "attached"].includes(value.mode as string) ||
    typeof value.userBash !== "boolean"
  )
    throw new Error("Unsupported sandbox configuration");
  if (value.mode === "attached") {
    validateOciAttachment(value.attachment);
    return Object.freeze({
      version: 4,
      mode: "attached",
      attachment: Object.freeze({ ...value.attachment }),
      userBash: value.userBash,
    });
  }
  record(value.backend);
  const input = value.backend;
  let backend: OwnedSandboxConfig["backend"];
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
  } else if (input.kind === "smolvm") {
    keys(input, [
      "kind",
      "executable",
      "image",
      "imageSha256",
      "stateDirectory",
      "resources",
      "cwdWritable",
      "environment",
    ]);
    for (const field of [input.executable, input.image, input.stateDirectory]) absolute(field);
    record(input.resources);
    if (
      typeof input.cwdWritable !== "boolean" ||
      typeof input.imageSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(input.imageSha256)
    )
      throw new Error("Invalid smolvm options");
    const resources = Object.freeze({ ...input.resources }) as unknown as SmolvmResources;
    const env = environment(input.environment);
    validateSmolvmResources(resources);
    smolvmEnvironment(env);
    backend = {
      kind: "smolvm",
      executable: input.executable as string,
      image: input.image as string,
      imageSha256: input.imageSha256,
      stateDirectory: input.stateDirectory as string,
      resources,
      cwdWritable: input.cwdWritable,
      environment: env,
    };
  } else throw new Error("Unsupported sandbox backend");
  return Object.freeze({
    version: 4,
    mode: "owned",
    backend: Object.freeze(backend),
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
