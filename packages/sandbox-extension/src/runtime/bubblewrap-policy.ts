import path from "node:path";

import type { NetworkMode } from "./contracts.js";

import {
  PRIVATE_SANDBOX_SYSTEM_PATHS,
  isNormalizedAbsoluteFilePath,
  isReservedHiddenDirectoryPath,
} from "./paths.js";

const SAFE_ENVIRONMENT = Object.freeze({
  HOME: "/run/pi-sandbox/home",
  USER: "sandbox",
  LOGNAME: "sandbox",
  SHELL: "/bin/bash",
  PATH: "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
  LANG: "C.UTF-8",
  LC_ALL: "C.UTF-8",
  TMPDIR: "/tmp",
  XDG_CACHE_HOME: "/run/pi-sandbox/cache",
  XDG_CONFIG_HOME: "/run/pi-sandbox/config",
  XDG_STATE_HOME: "/run/pi-sandbox/state",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  NO_COLOR: "1",
} as const);

const RESERVED_ENVIRONMENT_VARIABLES = new Set([
  "BASH_ENV",
  "BUN_OPTIONS",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
  "ENV",
  "LD_AUDIT",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PI_SANDBOX_CONFIG",
  "PI_SANDBOX_EXTENSION",
  "PI_SANDBOX_MANIFEST",
  "PI_SANDBOX_RUNTIME",
  "SHELLOPTS",
]);

export interface SandboxMountDescription {
  readonly target: string;
  readonly access: "read-only" | "read/write" | "private" | "limited";
  readonly content: string;
}

export const BUBBLEWRAP_STATUS_FD = 3;
export const BUBBLEWRAP_SECCOMP_FD = 4;
export const BUBBLEWRAP_FILE_MASK_FIRST_FD = 5;

export interface HiddenPathMask {
  readonly target: string;
  readonly kind: "directory" | "file";
}

/**
 * Construct the process-lifetime boundary for the internal command worker. The
 * host root is visible read-only at identical absolute paths, with the captured
 * CWD explicitly overlaid with its configured access. Ordering is security-sensitive: private
 * pseudo-filesystems are mounted after the host root and before the same-path
 * CWD.
 */
export function buildBubblewrapArguments(
  cwd: string,
  argv: readonly [string, ...string[]],
  networkMode: NetworkMode = "none",
  environment: Readonly<Record<string, string>> = {},
  cwdWritable = true,
  hiddenMasks: readonly HiddenPathMask[] = [],
): readonly string[] {
  assertSandboxCwd(cwd, cwdWritable);
  const masks = planHiddenPaths(
    cwd,
    hiddenMasks.map(({ target }) => target),
  );
  const kinds = new Map(hiddenMasks.map(({ target, kind }) => [target, kind]));
  assertNetworkMode(networkMode);
  const customEnvironment = validateSandboxEnvironment(environment);
  if (!path.isAbsolute(argv[0])) {
    throw new Error("sandbox_executable_not_absolute");
  }

  const args = [
    "--die-with-parent",
    "--new-session",
    "--unshare-all",
    ...(networkMode === "host" ? ["--share-net"] : []),
    "--unshare-user",
    "--disable-userns",
    "--assert-userns-disabled",
    "--hostname",
    "pi-sandbox",
    "--clearenv",
    "--cap-drop",
    "ALL",
    "--ro-bind",
    "/",
    "/",
    "--proc",
    "/proc",
    "--tmpfs",
    "/sys",
    "--chmod",
    "0555",
    "/sys",
    "--dev",
    "/dev",
    "--tmpfs",
    "/tmp",
    "--tmpfs",
    "/run",
    "--dir",
    "/run/pi-sandbox",
    "--dir",
    "/run/pi-sandbox/home",
    "--dir",
    "/run/pi-sandbox/cache",
    "--dir",
    "/run/pi-sandbox/config",
    "--dir",
    "/run/pi-sandbox/state",
  ];
  let nextFileMaskFd = BUBBLEWRAP_FILE_MASK_FIRST_FD;
  const addMask = (target: string): void => {
    if (kinds.get(target) === "file") {
      // Bubblewrap consumes and closes each data FD, so every file has its own
      // empty input. The resulting bind mount is private and read-only.
      args.push("--ro-bind-data", String(nextFileMaskFd++), target);
    } else {
      args.push("--tmpfs", target);
    }
  };
  for (const target of masks.beforeCwd) addMask(target);
  args.push(
    // Restore only the launch workspace through any hidden ancestor.
    "--dir",
    cwd,
    cwdWritable ? "--bind" : "--ro-bind",
    cwd,
    cwd,
  );
  for (const target of masks.afterCwd) addMask(target);
  // Freeze masks after creating the CWD's private ancestor skeleton. This
  // remount is non-recursive, preserving the CWD's configured access.
  for (const target of [...masks.beforeCwd, ...masks.afterCwd]) {
    if (kinds.get(target) === "directory") args.push("--remount-ro", target);
  }
  for (const [key, value] of Object.entries(SAFE_ENVIRONMENT)) {
    args.push("--setenv", key, value);
  }
  for (const [key, value] of customEnvironment) {
    args.push("--setenv", key, value);
  }
  args.push(
    "--chdir",
    cwd,
    "--json-status-fd",
    String(BUBBLEWRAP_STATUS_FD),
    "--seccomp",
    String(BUBBLEWRAP_SECCOMP_FD),
    "--",
    ...argv,
  );
  return Object.freeze(args);
}

function validateSandboxEnvironment(
  environment: Readonly<Record<string, string>>,
): readonly (readonly [string, string])[] {
  if (typeof environment !== "object" || environment === null || Array.isArray(environment)) {
    throw new Error("sandbox_environment_invalid");
  }
  const entries = Object.entries(environment).sort(([left], [right]) => left.localeCompare(right));
  for (const [name, value] of entries) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      typeof value !== "string" ||
      value.includes("\0") ||
      Object.hasOwn(SAFE_ENVIRONMENT, name) ||
      RESERVED_ENVIRONMENT_VARIABLES.has(name) ||
      name.startsWith("PI_SANDBOX_")
    ) {
      throw new Error("sandbox_environment_invalid");
    }
  }
  return entries;
}

function assertNetworkMode(networkMode: NetworkMode): void {
  if (networkMode !== "none" && networkMode !== "local" && networkMode !== "host") {
    throw new Error("sandbox_network_mode_invalid");
  }
}

/** Describe the configured mount policy without probing paths or exposing Bubblewrap's raw argv. */
export function describeBubblewrapMounts(
  cwd: string,
  cwdWritable = true,
  hiddenPaths: readonly string[] = [],
): readonly SandboxMountDescription[] {
  assertSandboxCwd(cwd, cwdWritable);
  const masks = planHiddenPaths(cwd, hiddenPaths);
  return Object.freeze([
    { target: "/", access: "read-only", content: "host filesystem" },
    ...masks.beforeCwd.map((target) => ({
      target,
      access: "read-only" as const,
      content: "hidden host path (mask if present at startup)",
    })),
    {
      target: cwd,
      access: cwdWritable ? "read/write" : "read-only",
      content: "host launch directory",
    },
    ...masks.afterCwd.map((target) => ({
      target,
      access: "read-only" as const,
      content: "hidden host path (mask if present at startup)",
    })),
    ...(cwd === "/tmp"
      ? []
      : [{ target: "/tmp", access: "read/write" as const, content: "private tmpfs" }]),
    { target: "/run", access: "read/write", content: "private tmpfs" },
    { target: "/proc", access: "private", content: "sandbox process view" },
    { target: "/sys", access: "private", content: "empty private filesystem" },
    { target: "/dev", access: "limited", content: "private device view" },
  ]);
}

export function assertSandboxCwd(cwd: string, cwdWritable = true): void {
  if (typeof cwdWritable !== "boolean") throw new Error("sandbox_cwd_writable_invalid");
  if (cwd === "/tmp" && !cwdWritable) throw new Error("sandbox_cwd_masks_private_tmp");
  if (
    !path.isAbsolute(cwd) ||
    path.normalize(cwd) !== cwd ||
    cwd === "/" ||
    hasControlCharacter(cwd)
  ) {
    throw new Error("sandbox_cwd_invalid");
  }
  for (const protectedPath of PRIVATE_SANDBOX_SYSTEM_PATHS) {
    if (isWithin(protectedPath, cwd) || isWithin(cwd, protectedPath)) {
      throw new Error("sandbox_cwd_overlaps_private_system_path");
    }
  }
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint === 0 || (codePoint >= 1 && codePoint <= 31) || codePoint === 127) {
      return true;
    }
  }
  return false;
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

/** Pure mount planning; the executor additionally checks host existence and realpath. */
export function planHiddenPaths(
  cwd: string,
  hiddenPaths: readonly string[],
): { readonly beforeCwd: readonly string[]; readonly afterCwd: readonly string[] } {
  if (!Array.isArray(hiddenPaths) || new Set(hiddenPaths).size !== hiddenPaths.length) {
    throw new Error("sandbox_hidden_paths_invalid");
  }
  const ordered: string[] = [];
  for (const target of hiddenPaths) {
    if (!isNormalizedAbsoluteFilePath(target)) throw new Error("sandbox_hidden_path_invalid");
    if (target === cwd) throw new Error("sandbox_hidden_path_is_cwd");
    if (isReservedHiddenDirectoryPath(target)) {
      throw new Error("sandbox_hidden_path_overlaps_private_system_path");
    }
    ordered.push(target);
  }
  ordered.sort((left, right) => left.length - right.length || left.localeCompare(right));
  const minimal = (paths: readonly string[]): readonly string[] =>
    Object.freeze(
      paths.filter(
        (target, index) => !paths.slice(0, index).some((ancestor) => isWithin(ancestor, target)),
      ),
    );
  // A mask inside CWD must survive restoration even when a configured parent
  // outside CWD already covers it. Reduce redundancy separately on each side.
  return Object.freeze({
    beforeCwd: minimal(ordered.filter((target) => !isWithin(cwd, target))),
    afterCwd: minimal(ordered.filter((target) => isWithin(cwd, target))),
  });
}

export function safeSandboxEnvironment(): Readonly<Record<string, string>> {
  return SAFE_ENVIRONMENT;
}
