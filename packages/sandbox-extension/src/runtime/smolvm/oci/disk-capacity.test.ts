import { mkdtemp, open, rm, symlink, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { afterEach, expect, it } from "vitest";
import { verifyOciDiskCapacity } from "./disk-capacity.js";

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
  await expect(verifyOciDiskCapacity(dir, resources)).resolves.toBeUndefined();
  await expect(verifyOciDiskCapacity(dir, { ...resources, storageGiB: 2 })).rejects.toThrow(
    "capacity_mismatch",
  );
  const h = await open(path.join(dir, "overlay.raw"), "r+");
  try {
    await h.truncate(2 * 1024 ** 3);
  } finally {
    await h.close();
  }
  await expect(verifyOciDiskCapacity(dir, resources)).rejects.toThrow("capacity_mismatch");
  await unlink(path.join(dir, "overlay.raw"));
  await symlink(path.join(dir, "storage.raw"), path.join(dir, "overlay.raw"));
  await expect(verifyOciDiskCapacity(dir, resources)).rejects.toThrow("capacity_mismatch");
});

it("validates shared seed overlay virtual capacity rather than sparse host file length", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "oci-seed-capacity-"));
  roots.push(dir);
  const header = Buffer.alloc(32);
  header.writeUInt32BE(0x514649fb);
  header.writeUInt32BE(3, 4);
  header.writeBigUInt64BE(20n * 1024n ** 3n, 24);
  await writeFile(path.join(dir, "storage.qcow2"), header);
  const raw = await open(path.join(dir, "overlay.raw"), "wx");
  try {
    await raw.truncate(1024 ** 3);
  } finally {
    await raw.close();
  }
  const resources = { cpus: 1, memoryMiB: 512, storageGiB: 20, overlayGiB: 1 };
  await expect(verifyOciDiskCapacity(dir, resources)).resolves.toBeUndefined();
  await expect(verifyOciDiskCapacity(dir, { ...resources, storageGiB: 21 })).rejects.toThrow(
    "capacity_mismatch",
  );
  header.writeUInt32BE(0, 0);
  await writeFile(path.join(dir, "storage.qcow2"), header);
  await expect(verifyOciDiskCapacity(dir, resources)).rejects.toThrow("capacity_mismatch");
});
