import { mkdtemp, mkdir, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import {
  claimColdRecord,
  mountIdentities,
  publishColdRecord,
  readColdRecord,
  type ColdRecord,
} from "./retention.js";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture() {
  const statePath = await mkdtemp(path.join(os.tmpdir(), "oci-seal-"));
  dirs.push(statePath);
  return statePath;
}
function record(statePath: string): ColdRecord {
  return {
    version: 1,
    mode: "cold",
    statePath,
    cwd: "/workspace",
    imageSha256: "a".repeat(64),
    runtimeIdentity: "b".repeat(64),
    mountIdentities: [],
    options: {
      smolvmPath: "/trusted/smolvm",
      imageArchive: "/trusted/image.tar",
      imageSha256: "a".repeat(64),
      stateDirectory: path.dirname(statePath),
      cwd: "/workspace",
      networkMode: "none",
      resources: { cpus: 1, memoryMiB: 512, storageGiB: 2, overlayGiB: 1 },
    },
  };
}
it("publishes complete private single-use records and refuses stale claims", async () => {
  const dir = await fixture();
  const value = record(dir);
  await publishColdRecord(value);
  expect(await readColdRecord(dir)).toEqual(value);
  const results = await Promise.allSettled([claimColdRecord(dir), claimColdRecord(dir)]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  await expect(readColdRecord(dir)).rejects.toBeDefined();
  // A stale claim is fail-closed even if an operator duplicates a ready record.
  await writeFile(
    path.join(dir, "cold-ready.json"),
    await readFile(path.join(dir, "cold-claimed.json")),
    { mode: 0o600 },
  );
  await expect(claimColdRecord(dir)).rejects.toMatchObject({ code: "EEXIST" });
});
it("rejects symlink, permissive, oversized and unsupported record shapes", async () => {
  const dir = await fixture();
  const ready = path.join(dir, "cold-ready.json");
  const other = path.join(dir, "other");
  await writeFile(other, JSON.stringify(record(dir)), { mode: 0o600 });
  await symlink(other, ready);
  await expect(readColdRecord(dir)).rejects.toBeDefined();
  await unlink(ready);
  await writeFile(ready, JSON.stringify(record(dir)), { mode: 0o644 });
  await expect(readColdRecord(dir)).rejects.toThrow("cold_state_invalid");
  await unlink(ready);
  await writeFile(ready, " ".repeat(65537), { mode: 0o600 });
  await expect(readColdRecord(dir)).rejects.toThrow("cold_state_invalid");
  await writeFile(ready, JSON.stringify({ ...record(dir), mode: "resume-ram" }));
  await expect(readColdRecord(dir)).rejects.toThrow("cold_state_invalid");
});
it("fingerprints external input directory identity", async () => {
  const dir = await fixture();
  const input = path.join(dir, "input");
  await mkdir(input);
  const options = {
    ...record(dir).options,
    mounts: [{ hostPath: input, guestPath: "/input", readOnly: true as const }],
  };
  const before = await mountIdentities(options);
  await rename(input, input + "-old");
  await mkdir(input);
  expect(await mountIdentities(options)).not.toEqual(before);
});
