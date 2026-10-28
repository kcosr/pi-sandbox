import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";

import { isNormalizedAbsoluteFilePath, PRIVATE_SANDBOX_SYSTEM_PATHS } from "./paths.js";

export const MAXIMUM_COMMAND_PATH_ENTRIES = 64;
export const MAXIMUM_COMMAND_PATH_BYTES = 16 * 1024;

/** Syntax-only snapshot; installation validation must not probe the target filesystem. */
export function snapshotCommandPathPrepend(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (
    !Array.isArray(value) ||
    value.length > MAXIMUM_COMMAND_PATH_ENTRIES ||
    Array.from(value).some(
      (entry: unknown) =>
        !isNormalizedAbsoluteFilePath(entry) ||
        Buffer.from(entry, "utf8").toString("utf8") !== entry ||
        /[:\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|\{\{|\}\}/u.test(entry),
    ) ||
    new Set(value).size !== value.length ||
    Buffer.byteLength(value.join(":")) > MAXIMUM_COMMAND_PATH_BYTES
  )
    throw new Error("sandbox_command_path_invalid");
  return Object.freeze([...(value as string[])]);
}

export interface CommandPathContext {
  readonly backend: "bubblewrap" | "seatbelt" | "direct";
  readonly cwd: string;
  readonly cwdWritable?: boolean;
  readonly hiddenPaths?: readonly string[];
  readonly deniedPaths?: readonly string[];
  readonly privatePaths?: readonly string[];
}

function within(root: string, target: string): boolean {
  return root === "/" || target === root || target.startsWith(`${root}/`);
}

/** No extra mounts or grants: each configured directory must retain its host meaning. */
export function assertCommandPathPlacement(
  paths: readonly string[],
  context: CommandPathContext,
): void {
  const privatePaths = [
    ...(context.backend === "bubblewrap" ? [...PRIVATE_SANDBOX_SYSTEM_PATHS, "/tmp"] : []),
    ...(context.privatePaths ?? []),
  ];
  const unavailable =
    context.backend === "bubblewrap"
      ? (context.hiddenPaths ?? [])
      : context.backend === "seatbelt"
        ? (context.deniedPaths ?? [])
        : [];
  for (const directory of paths) {
    if ((context.cwdWritable ?? true) && within(context.cwd, directory))
      throw new Error("sandbox_command_path_workspace_overlap");
    if (
      privatePaths.some((root) => within(root, directory)) ||
      unavailable.some((root) => within(root, directory) || within(directory, root))
    )
      throw new Error("sandbox_command_path_unavailable");
  }
}

/**
 * Managed startup resolves aliases once. Low-level constructors require those canonical
 * strings and reject later rebinding instead of silently changing the analyzer's PATH.
 * This is a startup snapshot, not an inode lease or a complete symlink-ancestry proof.
 */
export async function canonicalizeCommandPathPrepend(
  input: unknown,
  context: CommandPathContext,
  requireCanonical = false,
): Promise<readonly string[]> {
  const paths = snapshotCommandPathPrepend(input);
  const snapshot = {
    ...context,
    hiddenPaths: Object.freeze([...(context.hiddenPaths ?? [])]),
    deniedPaths: Object.freeze([...(context.deniedPaths ?? [])]),
    privatePaths: Object.freeze([...(context.privatePaths ?? [])]),
  };
  assertCommandPathPlacement(paths, snapshot);
  const result: string[] = [];
  for (const directory of paths) {
    const resolved = await realpath(directory);
    snapshotCommandPathPrepend([resolved]);
    if (requireCanonical && resolved !== directory)
      throw new Error("sandbox_command_path_not_canonical");
    if (!(await stat(resolved)).isDirectory())
      throw new Error("sandbox_command_path_not_directory");
    await access(resolved, constants.X_OK);
    assertCommandPathPlacement([resolved], snapshot);
    if (result.includes(resolved)) throw new Error("sandbox_command_path_duplicate");
    result.push(resolved);
  }
  return snapshotCommandPathPrepend(result);
}
