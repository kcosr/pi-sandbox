import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { assertGuestPath } from "./request.js";

export interface SmolvmRegistryIdentity {
  readonly home: string;
  readonly dataDirectory: string;
  readonly cacheDirectory: string;
  readonly configFile: string;
}

/** Native runtime context, captured once. Guest/request environments never select it. */
export function createSmolvmEnvironment(): Record<string, string> {
  const environment: Record<string, string> = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
    HOME: process.env.HOME || homedir(),
  };
  for (const key of [
    "XDG_DATA_HOME",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_STATE_HOME",
    "XDG_RUNTIME_DIR",
    "SMOLVM_CONFIG",
  ]) {
    const value = process.env[key];
    if (value !== undefined) {
      assertGuestPath(value);
      environment[key] = value;
    }
  }
  assertGuestPath(environment.HOME);
  // Pin settings independently from cwd and later ambient changes.
  environment.SMOLVM_CONFIG ??= path.join(environment.HOME, ".config/smolvm/config.toml");
  return environment;
}

/** Resolve aliases in existing ancestors without creating runtime-owned storage. */
export async function resolvedPath(value: string): Promise<string> {
  assertGuestPath(value);
  try {
    return await realpath(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || value === "/") throw error;
    return path.join(await resolvedPath(path.dirname(value)), path.basename(value));
  }
}

export async function registryIdentity(
  environment: Readonly<Record<string, string>>,
): Promise<SmolvmRegistryIdentity> {
  const home = environment.HOME!;
  const data =
    process.platform === "darwin"
      ? path.join(home, "Library/Application Support")
      : (environment.XDG_DATA_HOME ?? path.join(home, ".local/share"));
  return {
    home: await resolvedPath(home),
    dataDirectory: await resolvedPath(path.join(data, "smolvm")),
    cacheDirectory: await resolvedPath(nativeCacheDirectory(environment)),
    configFile: await resolvedPath(environment.SMOLVM_CONFIG!),
  };
}

function nativeCacheDirectory(environment: Readonly<Record<string, string>>): string {
  return process.platform === "darwin"
    ? path.join(environment.HOME!, "Library/Caches")
    : (environment.XDG_CACHE_HOME ?? path.join(environment.HOME!, ".cache"));
}

/** Names hash to sixteen ASCII bytes; check the actual upstream socket budget. */
export function validateSmolvmSocketPaths(environment: Readonly<Record<string, string>>): void {
  const socket = path.join(
    nativeCacheDirectory(environment),
    "smolvm/vms/0000000000000000/control.sock",
  );
  if (Buffer.byteLength(socket) > (process.platform === "darwin" ? 103 : 107))
    throw new Error("smolvm_native_socket_path_too_long");
}

export function validateNamePrefix(prefix: unknown): asserts prefix is string {
  if (
    typeof prefix !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,94}$/u.test(prefix) ||
    prefix.endsWith("-") ||
    prefix.includes("--")
  )
    throw new Error("smolvm_name_prefix_invalid");
}
export function uniqueMachineName(prefix = "pi"): string {
  validateNamePrefix(prefix);
  return `${prefix}-${randomUUID().replaceAll("-", "")}`;
}
export function validMachineName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(name) &&
    !name.endsWith("-") &&
    !name.includes("--")
  );
}

export function validateRegistryIdentity(value: unknown): asserts value is SmolvmRegistryIdentity {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "cacheDirectory,configFile,dataDirectory,home"
  )
    throw new Error("smolvm_registry_identity_invalid");
  for (const field of Object.values(value)) assertGuestPath(field);
}
