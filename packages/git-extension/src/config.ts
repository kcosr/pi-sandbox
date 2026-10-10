import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { parseGitCloneConfig, type GitCloneConfig } from "./core.js";

export interface GitExtensionConfig {
  readonly version: 1;
  readonly allowed_hosts: GitCloneConfig["allowed_hosts"];
  readonly allowed_schemes: GitCloneConfig["allowed_schemes"];
}

export function parseGitConfig(raw: unknown): GitExtensionConfig {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error("Git configuration must be an object");
  const value = raw as Record<string, unknown>;
  const prototype: unknown = Object.getPrototypeOf(value);
  if (!Object.hasOwn(value, "version")) throw new Error("Git configuration version is required");
  if ((prototype !== Object.prototype && prototype !== null) || value.version !== 1)
    throw new Error("Unsupported Git configuration version");
  const policy = { ...value };
  delete policy.version;
  return Object.freeze({ version: 1, ...parseGitCloneConfig(policy, "Git configuration") });
}

export async function readGitConfig(file: string): Promise<GitExtensionConfig> {
  if (!isAbsolute(file) || normalize(file) !== file || /[\0\r\n]/u.test(file))
    throw new Error("Expected normalized absolute Git configuration path");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > 65536 ||
      (stat.mode & 0o077) !== 0 ||
      (process.getuid && stat.uid !== process.getuid())
    )
      throw new Error("Git config must be a private owned regular file under 64 KiB");
    const buffer = Buffer.alloc(65537);
    let length = 0;
    while (length < buffer.length) {
      const result = await handle.read(buffer, length, buffer.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > 65536) throw new Error("Git config exceeds 64 KiB");
    return parseGitConfig(JSON.parse(buffer.subarray(0, length).toString("utf8")) as unknown);
  } finally {
    await handle.close();
  }
}
