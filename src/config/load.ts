import { constants } from "node:fs";
import { open } from "node:fs/promises";

import type { AuthoredPiEnvironmentValue, AuthoredSandboxConfig } from "../domain/index.js";
import type { ManagedExtensionCatalog } from "../managed-extensions/catalog.js";
import { ConfigError } from "./errors.js";
import { MAXIMUM_CONFIG_BYTES, parseConfig } from "./parse.js";

export async function loadConfig(
  path: string,
  catalog: ManagedExtensionCatalog,
): Promise<AuthoredSandboxConfig<AuthoredPiEnvironmentValue>> {
  let sourceText: string;
  try {
    // Do not wait for a FIFO writer before checking the descriptor's file type.
    const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const metadata = await file.stat();
      if (!metadata.isFile()) throw new ConfigError(path, ["configuration must be a regular file"]);
      if (metadata.size > MAXIMUM_CONFIG_BYTES)
        throw new ConfigError(path, [`configuration exceeds ${MAXIMUM_CONFIG_BYTES} bytes`]);
      const bytes = Buffer.alloc(MAXIMUM_CONFIG_BYTES + 1);
      let length = 0;
      while (length < bytes.length) {
        const result = await file.read(bytes, length, bytes.length - length, null);
        if (result.bytesRead === 0) break;
        length += result.bytesRead;
      }
      if (length > MAXIMUM_CONFIG_BYTES)
        throw new ConfigError(path, [`configuration exceeds ${MAXIMUM_CONFIG_BYTES} bytes`]);
      try {
        // Preserve a BOM as authored data; invalid bytes must never become replacement text.
        sourceText = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          bytes.subarray(0, length),
        );
      } catch (error) {
        throw new ConfigError(path, ["configuration file must contain valid UTF-8"], error);
      }
    } finally {
      await file.close();
    }
  } catch (error) {
    if (error instanceof ConfigError) throw error;
    throw new ConfigError(path, ["configuration file could not be read"], error);
  }

  return parseConfig(sourceText, path, catalog);
}
