import { readFile } from "node:fs/promises";

import type { SandboxConfig } from "../domain/index.js";
import type { ManagedExtensionCatalog } from "../managed-extensions/catalog.js";
import { ConfigError } from "./errors.js";
import { parseConfig } from "./parse.js";

export async function loadConfig(
  path: string,
  catalog: ManagedExtensionCatalog,
): Promise<SandboxConfig> {
  let sourceText: string;
  try {
    sourceText = await readFile(path, "utf8");
  } catch (error) {
    throw new ConfigError(path, ["configuration file could not be read"], error);
  }

  return parseConfig(sourceText, path, catalog);
}
