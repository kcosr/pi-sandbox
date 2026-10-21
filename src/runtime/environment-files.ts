import { constants } from "node:fs";
import { open } from "node:fs/promises";

import {
  MAXIMUM_ENVIRONMENT_VALUE_BYTES,
  parseBrokerManagedEnvironment,
  type ManagedEnvironment,
  type PendingPiEnvironmentValue,
  type ResolvedPiEnvironmentValue,
} from "../domain/index.js";

const MAXIMUM_FILE_BYTES = MAXIMUM_ENVIRONMENT_VALUE_BYTES + 2;
const FILE_ERROR = "Pi environment file could not be read or has invalid contents";

/** Ordinary filesystem permissions and symlink resolution apply under the reader's identity. */
export async function readEnvironmentFile(path: string): Promise<string> {
  let file: Awaited<ReturnType<typeof open>> | undefined;
  let result: string | undefined;
  let failed = false;
  try {
    // O_NONBLOCK avoids waiting for a FIFO writer before the descriptor type check.
    file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
    const metadata = await file.stat();
    if (!metadata.isFile() || metadata.size > MAXIMUM_FILE_BYTES) throw new Error(FILE_ERROR);
    const buffer = Buffer.alloc(MAXIMUM_FILE_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, null);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > MAXIMUM_FILE_BYTES) throw new Error(FILE_ERROR);
    // ignoreBOM preserves the initial BOM as data rather than silently consuming it.
    let value = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      buffer.subarray(0, length),
    );
    if (value.endsWith("\r\n")) value = value.slice(0, -2);
    else if (value.endsWith("\n")) value = value.slice(0, -1);
    if (
      value.length === 0 ||
      value.includes("\0") ||
      Buffer.byteLength(value) > MAXIMUM_ENVIRONMENT_VALUE_BYTES
    )
      throw new Error(FILE_ERROR);
    result = value;
  } catch {
    // Never attach filesystem errors: their messages and causes expose secret paths.
    failed = true;
  } finally {
    if (file !== undefined) {
      try {
        await file.close();
      } catch {
        failed = true;
      }
    }
  }
  if (failed || result === undefined) throw new Error(FILE_ERROR);
  return result;
}

/** Resolve only effective references, caching within this startup, never across startups. */
export async function resolveEnvironmentFiles(
  environment: ManagedEnvironment<PendingPiEnvironmentValue>,
  readFile: (path: string) => Promise<string> = readEnvironmentFile,
): Promise<ManagedEnvironment<ResolvedPiEnvironmentValue>> {
  const cache = new Map<string, string>();
  const pi: Array<[string, ResolvedPiEnvironmentValue]> = [];
  for (const [name, value] of Object.entries(environment.pi)) {
    if (typeof value === "string" || "literal" in value) {
      pi.push([name, value]);
      continue;
    }
    let literal = cache.get(value.file);
    if (literal === undefined) {
      literal = await readFile(value.file);
      cache.set(value.file, literal);
    }
    pi.push([name, Object.freeze({ literal })]);
  }
  return parseBrokerManagedEnvironment({ ...environment, pi: Object.fromEntries(pi) });
}
