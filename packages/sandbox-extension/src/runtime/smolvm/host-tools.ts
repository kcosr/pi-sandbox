import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, realpath } from "node:fs/promises";
import path from "node:path";
import type { DarwinProcessQuery } from "./darwin-query.js";
import { fileSha256 } from "./runtime-release.js";

export interface SmolvmHostTools {
  readonly e2fsprogsDirectory?: string;
  readonly darwinProcessQuery?: DarwinProcessQuery;
}
const invalid = () => new Error("smolvm_host_tools_invalid");
function normalized(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !path.isAbsolute(value) ||
    path.normalize(value) !== value ||
    /[\0\r\n:]/u.test(value) ||
    value === "/"
  )
    throw invalid();
}
/** Shape-only validation; factory verification enforces the executing platform. */
export function validateHostTools(options: SmolvmHostTools): void {
  if (options.e2fsprogsDirectory !== undefined) normalized(options.e2fsprogsDirectory);
  const query = options.darwinProcessQuery;
  if (query !== undefined) {
    if (
      !query ||
      typeof query !== "object" ||
      Array.isArray(query) ||
      Object.keys(query).sort().join(",") !== "path,sha256" ||
      typeof query.sha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(query.sha256)
    )
      throw invalid();
    normalized(query.path);
  }
}
// Matches pinned upstream disk_utils.rs: fixed prefixes win over PATH.
const prefixes = [
  "/opt/homebrew/opt/e2fsprogs/sbin",
  "/usr/local/opt/e2fsprogs/sbin",
  "/opt/homebrew/sbin",
  "/usr/local/sbin",
  "/sbin",
  "/usr/sbin",
  "/usr/bin",
  "/bin",
];
export async function verifyHostTools(
  options: SmolvmHostTools,
  mounts: readonly string[],
  platform = process.platform,
): Promise<string | undefined> {
  validateHostTools(options);
  if (
    platform === "darwin" ? !options.darwinProcessQuery : options.darwinProcessQuery !== undefined
  )
    throw invalid();
  const protectedPaths: string[] = [];
  const identities: { role: string; path: string; target: string; sha256: string }[] = [];
  async function executable(role: string, file: string, expected?: string) {
    const target = await realpath(file);
    const st = await lstat(target);
    if (!st.isFile() || st.mode & 0o022) throw invalid();
    await access(target, constants.X_OK);
    const sha256 = await fileSha256(target);
    if (expected && sha256 !== expected) throw new Error("smolvm_host_tool_digest_mismatch");
    protectedPaths.push(file, target);
    identities.push({ role, path: file, target, sha256 });
    return target;
  }
  if (options.darwinProcessQuery) {
    const q = options.darwinProcessQuery;
    if ((await realpath(q.path)) !== q.path || (await lstat(q.path)).nlink !== 1) throw invalid();
    await executable("process-query", q.path, q.sha256);
  }
  if (options.e2fsprogsDirectory) {
    const directory = options.e2fsprogsDirectory;
    if ((await realpath(directory)) !== directory || !(await lstat(directory)).isDirectory())
      throw invalid();
    protectedPaths.push(directory);
    for (const tool of ["resize2fs", "e2fsck"]) {
      const selected = await executable(tool, path.join(directory, tool));
      for (const prefix of prefixes) {
        const candidate = path.join(prefix, tool);
        try {
          await lstat(candidate);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        if ((await realpath(candidate)) !== selected)
          throw new Error("smolvm_disk_tool_selection_conflict");
        break;
      }
    }
  }
  const inside = (a: string, b: string) => a === "/" || a === b || b.startsWith(`${a}/`);
  if (mounts.some((m) => protectedPaths.some((p) => inside(m, p) || inside(p, m))))
    throw new Error("smolvm_host_tools_overlap_mount");
  return identities.length
    ? createHash("sha256").update(JSON.stringify(identities)).digest("hex")
    : undefined;
}
