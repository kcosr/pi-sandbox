import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
export function nativeSmolvmHostTools() {
  return process.env.PI_SANDBOX_E2FSPROGS_DIRECTORY
    ? { e2fsprogsDirectory: process.env.PI_SANDBOX_E2FSPROGS_DIRECTORY }
    : {};
}
/** Fixture observation only, never a product lifecycle decision or generation proof. */
export async function nativeHostProcessAlive(pid: number): Promise<boolean> {
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid fixture pid");
  if (process.platform === "darwin") {
    try {
      const status = execFileSync("/bin/ps", ["-p", String(pid), "-o", "stat="], {
        encoding: "utf8",
        timeout: 3000,
        maxBuffer: 4096,
        env: { PATH: "/usr/bin:/bin", LANG: "C" },
      }).trim();
      if (!status) throw new Error("empty fixture process observation");
      return !status.startsWith("Z");
    } catch (error) {
      const e = error as { status?: number; stdout?: string };
      if (e.status === 1 && !String(e.stdout ?? "").trim()) return false;
      throw error;
    }
  }
  try {
    const s = await readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(s.slice(s.lastIndexOf(")") + 2).split(" ")[0]!);
  } catch (error) {
    if (["ENOENT", "ESRCH"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  }
}
/** Read-only, scoped assertion before deleting a whole disposable fixture account. */
export function assertNoFixtureLayerAttachments(root: string): void {
  if (process.platform !== "darwin") return;
  const env = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" };
  const plist = execFileSync("/usr/bin/hdiutil", ["info", "-plist"], {
    env,
    timeout: 5000,
    maxBuffer: 4 * 1048576,
  });
  const data = JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "--", "-"], {
      env,
      input: plist,
      encoding: "utf8",
      timeout: 5000,
      maxBuffer: 4 * 1048576,
    }),
  ) as { images?: { "image-path"?: string }[] };
  if (!Array.isArray(data.images)) throw new Error("fixture layer inventory invalid");
  for (const image of data.images) {
    if (typeof image["image-path"] !== "string") throw new Error("fixture image path missing");
    const p = path.normalize(image["image-path"]);
    if (p === root || p.startsWith(root + "/")) throw new Error("fixture layer still attached");
  }
}
