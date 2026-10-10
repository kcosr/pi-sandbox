import { mkdtemp, open, rm, symlink, unlink } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { verifyOciRawDiskCapacity } from "./disk-capacity.js";

const roots: string[] = [];
afterEach(async () => {
  for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true });
});
it("requires exact requested logical disk sizes and regular files", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oci-capacity-"));
  roots.push(dir);
  for (const file of ["storage.raw", "overlay.raw"]) {
    const h = await open(path.join(dir, file), "wx");
    try {
      await h.truncate(1024 ** 3);
    } finally {
      await h.close();
    }
  }
  const resources = { cpus: 1, memoryMiB: 512, storageGiB: 1, overlayGiB: 1 };
  await expect(verifyOciRawDiskCapacity(dir, resources)).resolves.toBeUndefined();
  await expect(verifyOciRawDiskCapacity(dir, { ...resources, storageGiB: 2 })).rejects.toThrow(
    "capacity_mismatch",
  );
  const h = await open(path.join(dir, "overlay.raw"), "r+");
  try {
    await h.truncate(2 * 1024 ** 3);
  } finally {
    await h.close();
  }
  await expect(verifyOciRawDiskCapacity(dir, resources)).rejects.toThrow("capacity_mismatch");
  await unlink(path.join(dir, "overlay.raw"));
  await symlink(path.join(dir, "storage.raw"), path.join(dir, "overlay.raw"));
  await expect(verifyOciRawDiskCapacity(dir, resources)).rejects.toThrow("capacity_mismatch");
});
