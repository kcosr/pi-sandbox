import { isAbsolute, resolve } from "node:path";

import { buildLayout, type CompiledLayout } from "../build-layout/index.js";
import type { WorkspaceMode } from "../domain/index.js";
import { managedArguments, validateManagedArguments } from "./arguments.js";

export interface SandboxArguments {
  readonly configPath: string;
  readonly piArgs: string[];
  readonly workspaceMode?: WorkspaceMode;
}

/** Consume administrative launch options before Pi sees arguments. */
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
  let workspaceMode: WorkspaceMode | undefined;
  if (piArgs[0] === "--writable-cwd" || piArgs[0] === "--read-only-cwd") {
    workspaceMode = piArgs[0] === "--writable-cwd" ? "read_write" : "read_only";
    piArgs = piArgs.slice(1);
  }
  for (const [argument] of managedArguments(piArgs)) {
    if (
      argument === "--writable-cwd" ||
      argument === "--read-only-cwd" ||
      argument.startsWith("--writable-cwd=") ||
      argument.startsWith("--read-only-cwd=")
    ) {
      throw new Error(
        "CWD mode must appear once, before Pi arguments: --writable-cwd or --read-only-cwd",
      );
    }
    if (
      workspaceMode !== undefined &&
      ["--validate-installation", "--print-execution-backend", "--version", "-v"].includes(argument)
    ) {
      throw new Error("CWD mode flags cannot be used with maintenance commands");
    }
    if (argument === "--config" || argument.startsWith("--config=")) {
      throw new Error(
        layout.allowConfigOverride
          ? "--config must appear once, before Pi arguments"
          : "This build does not permit --config",
      );
    }
  }
  validateManagedArguments(piArgs);
  return { configPath, piArgs, ...(workspaceMode === undefined ? {} : { workspaceMode }) };
}
