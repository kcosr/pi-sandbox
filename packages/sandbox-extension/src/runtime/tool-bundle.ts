import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { TOOL_COMMAND_NAMES, type ToolBundle, type ToolCommandName } from "./contracts.js";
import { isNormalizedAbsoluteFilePath } from "./paths.js";
import { snapshotCommandPathPrepend } from "./command-path.js";

function within(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}/`);
}

/** Snapshot only trusted constructor metadata before native asynchronous checks. */
export function snapshotToolBundle(input: ToolBundle | undefined): ToolBundle | undefined {
  if (input === undefined) return undefined;
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    Object.keys(input).some((key) => key !== "root" && key !== "commands") ||
    !isNormalizedAbsoluteFilePath(input.root) ||
    input.root.includes(":") ||
    !input.commands ||
    typeof input.commands !== "object" ||
    Array.isArray(input.commands)
  )
    throw new Error("sandbox_tool_bundle_invalid");
  const commands: Partial<Record<ToolCommandName, string>> = {};
  for (const [name, command] of Object.entries(input.commands)) {
    if (
      !(TOOL_COMMAND_NAMES as readonly string[]).includes(name) ||
      !isNormalizedAbsoluteFilePath(command) ||
      !within(input.root, command) ||
      command === input.root
    )
      throw new Error("sandbox_tool_bundle_command_invalid");
    commands[name as ToolCommandName] = command;
  }
  return Object.freeze({ root: input.root, commands: Object.freeze(commands) });
}

/** Selected files must exist at those exact canonical paths; there is no system fallback. */
export async function validateToolBundle(bundle: ToolBundle | undefined): Promise<void> {
  if (bundle === undefined) return;
  for (const directory of [bundle.root, path.join(bundle.root, "bin")]) {
    if ((await realpath(directory)) !== directory || !(await lstat(directory)).isDirectory())
      throw new Error("sandbox_tool_bundle_directory_invalid");
  }
  for (const command of Object.values(bundle.commands)) {
    if ((await realpath(command)) !== command || !(await lstat(command)).isFile())
      throw new Error("sandbox_tool_bundle_command_invalid");
    await access(command, constants.X_OK);
  }
}

/** Protect the entire installed bundle, including libraries and unselected helper binaries. */
export function assertToolBundlePlacement(
  bundle: ToolBundle | undefined,
  cwd: string,
  cwdWritable: boolean,
  denied: readonly string[] = [],
  privatePaths: readonly string[] = [],
): void {
  if (bundle === undefined) return;
  const overlaps = (target: string) => within(bundle.root, target) || within(target, bundle.root);
  if (cwdWritable && overlaps(cwd)) throw new Error("sandbox_tool_bundle_workspace_overlap");
  if ([...denied, ...privatePaths].some(overlaps))
    throw new Error("sandbox_tool_bundle_path_unavailable");
}

export function toolBundlePath(
  bundle: ToolBundle | undefined,
  fallback: string,
  commandPathPrepend: readonly string[] = [],
): string {
  const prefixes = snapshotCommandPathPrepend(commandPathPrepend);
  return [
    ...(bundle === undefined ? [] : [path.join(bundle.root, "bin")]),
    ...prefixes,
    fallback,
  ].join(":");
}
