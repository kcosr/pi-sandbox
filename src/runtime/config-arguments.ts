import { isAbsolute, resolve } from "node:path";

import { buildLayout, type CompiledLayout } from "../build-layout/index.js";
import { managedArguments, validateManagedArguments } from "./arguments.js";

export interface SandboxArguments {
  readonly configPath: string;
  readonly piArgs: string[];
  readonly workspaceMode?: string;
  readonly listWorkspaceModes?: true;
}

const MODE_INCOMPATIBLE_ARGUMENTS = new Set([
  "--version",
  "--validate-installation",
  "--print-execution-backend",
  "--pi-sandbox-internal-worker",
  "--pi-sandbox-internal-export-reader",
]);

/** Consume managed launch prefixes before Pi sees arguments. */
export function parseSandboxArguments(
  args: readonly string[],
  layout: Pick<CompiledLayout, "configPath" | "allowConfigOverride"> = buildLayout,
  cwd?: string,
): SandboxArguments {
  let configPath = layout.configPath;
  let piArgs = [...args];
  const first = args[0];
  if (first === "--config" || first?.startsWith("--config=") === true) {
    if (!layout.allowConfigOverride) throw new Error("This build does not permit --config");
    const value = first === "--config" ? args[1] : first.slice("--config=".length);
    if (
      value === undefined ||
      value.length === 0 ||
      value.startsWith("-") ||
      value.includes("\0")
    ) {
      throw new Error("--config requires a TOML file path");
    }
    configPath = isAbsolute(value) ? resolve(value) : resolve(cwd ?? process.cwd(), value);
    piArgs = args.slice(first === "--config" ? 2 : 1);
  }
  let workspaceMode: string | undefined;
  const modePrefix = piArgs[0];
  if (modePrefix === "--workspace-mode" || modePrefix?.startsWith("--workspace-mode=") === true) {
    const value =
      modePrefix === "--workspace-mode" ? piArgs[1] : modePrefix.slice("--workspace-mode=".length);
    if (value === undefined || !/^[a-z][a-z0-9_-]{0,31}$/u.test(value))
      throw new Error("--workspace-mode requires a valid mode name");
    workspaceMode = value;
    piArgs = piArgs.slice(modePrefix === "--workspace-mode" ? 2 : 1);
  }
  let listWorkspaceModes: true | undefined;
  for (const [argument] of managedArguments(piArgs)) {
    if (argument === "--config" || argument.startsWith("--config=")) {
      throw new Error(
        layout.allowConfigOverride
          ? "--config must appear once, before Pi arguments"
          : "This build does not permit --config",
      );
    }
    if (argument === "--workspace-mode" || argument.startsWith("--workspace-mode="))
      throw new Error(
        "--workspace-mode must appear once, after optional --config and before Pi arguments",
      );
    if (argument === "--list-workspace-modes" || argument.startsWith("--list-workspace-modes=")) {
      if (
        workspaceMode !== undefined ||
        piArgs.length !== 1 ||
        argument !== "--list-workspace-modes"
      )
        throw new Error("--list-workspace-modes accepts only an optional leading --config FILE");
      listWorkspaceModes = true;
    }
    if (workspaceMode !== undefined && MODE_INCOMPATIBLE_ARGUMENTS.has(argument))
      throw new Error(`--workspace-mode cannot be combined with ${argument}`);
  }
  validateManagedArguments(piArgs);
  return {
    configPath,
    piArgs,
    ...(workspaceMode === undefined ? {} : { workspaceMode }),
    ...(listWorkspaceModes === undefined ? {} : { listWorkspaceModes }),
  };
}
