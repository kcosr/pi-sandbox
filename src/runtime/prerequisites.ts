import { constants as fsConstants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";

import { REQUIRED_SANDBOX_EXECUTABLES } from "../../packages/sandbox-extension/src/runtime/index.js";
import type { CompiledLayout } from "../build-layout/index.js";
import type { ExecutionBackend } from "../domain/index.js";

const DEFAULT_FIXED_EXECUTABLES = REQUIRED_SANDBOX_EXECUTABLES;

const DEFAULT_PATH_COMMANDS = Object.freeze([
  { label: "fd or fdfind", names: ["fd", "fdfind"] },
  { label: "ripgrep (rg)", names: ["rg"] },
]);

/** Only executables that run on the host belong in this check. */
export function assertExecutionPrerequisites(
  backend: ExecutionBackend,
  layout: Pick<CompiledLayout, "bubblewrap" | "smolvm">,
  managedExecutables: readonly string[],
): Promise<void> {
  const provider =
    backend === "bubblewrap" ? layout.bubblewrap : backend === "smolvm" ? layout.smolvm : undefined;
  return assertHostPrerequisites({
    ...(backend !== "bubblewrap" ? { fixedExecutables: [] } : {}),
    ...(backend === "smolvm" ? { pathCommands: [] } : {}),
    additionalFixedExecutables: [
      ...managedExecutables,
      ...(provider === undefined ? [] : [provider.path]),
    ],
  });
}

interface HostPrerequisiteOptions {
  readonly fixedExecutables?: readonly string[];
  readonly additionalFixedExecutables?: readonly string[];
  readonly pathCommands?: readonly {
    readonly label: string;
    readonly names: readonly string[];
  }[];
  readonly path?: string;
}

async function isExecutable(path: string): Promise<boolean> {
  return access(path, fsConstants.X_OK).then(
    () => true,
    () => false,
  );
}

async function commandIsAvailable(names: readonly string[], pathValue: string): Promise<boolean> {
  for (const directory of pathValue.split(delimiter)) {
    if (directory.length === 0) continue;
    for (const name of names) {
      if (await isExecutable(join(directory, name))) return true;
    }
  }
  return false;
}

/** Fail before Pi starts when its offline host dependencies are incomplete. */
export async function assertHostPrerequisites(
  options: HostPrerequisiteOptions = {},
): Promise<void> {
  const fixedExecutables = [
    ...(options.fixedExecutables ?? DEFAULT_FIXED_EXECUTABLES),
    ...(options.additionalFixedExecutables ?? []),
  ];
  const pathCommands = options.pathCommands ?? DEFAULT_PATH_COMMANDS;
  const pathValue = options.path ?? process.env.PATH ?? "";
  const missing: string[] = [];

  for (const executable of fixedExecutables) {
    if (!(await isExecutable(executable))) missing.push(executable);
  }
  for (const command of pathCommands) {
    if (!(await commandIsAvailable(command.names, pathValue))) missing.push(command.label);
  }

  if (missing.length > 0) {
    throw new Error(
      `Missing required host executables:\n${missing.map((name) => `- ${name}`).join("\n")}\nInstall the operating-system packages that provide them, then retry.`,
    );
  }
}
