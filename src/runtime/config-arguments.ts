import { isAbsolute, resolve } from "node:path";

import { buildLayout, type CompiledLayout } from "../build-layout/index.js";
import { validateManagedArguments } from "./arguments.js";

export interface SandboxArguments {
  readonly configPath: string;
  readonly piArgs: string[];
}

/** Consume the optional build-enabled configuration prefix before Pi sees arguments. */
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
  for (const argument of piArgs) {
    if (argument === "--") break;
    if (argument === "--config" || argument.startsWith("--config=")) {
      throw new Error(
        layout.allowConfigOverride
          ? "--config must appear once, before Pi arguments"
          : "This build does not permit --config",
      );
    }
  }
  validateManagedArguments(piArgs);
  return { configPath, piArgs };
}
