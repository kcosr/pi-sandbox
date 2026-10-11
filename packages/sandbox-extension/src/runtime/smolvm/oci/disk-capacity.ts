import { constants, lstat, open } from "node:fs/promises";
import path from "node:path";
import type { SmolvmOciFamilyOptions } from "./types.js";

/** Check logical sizes for stock raw disks and shared-seed qcow2 overlays. */
export async function verifyOciDiskCapacity(
  directory: string,
  resources: SmolvmOciFamilyOptions["resources"],
): Promise<void> {
  for (const [stem, gib] of [
    ["storage", resources.storageGiB],
    ["overlay", resources.overlayGiB],
  ] as const) {
    const fail = () => new Error(`smolvm_oci_${stem}_capacity_mismatch`);
    let format: "raw" | "qcow2" = "qcow2";
    try {
      await lstat(path.join(directory, `${stem}.qcow2`));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      format = "raw";
    }
    const file = await open(
      path.join(directory, `${stem}.${format}`),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    ).catch(() => {
      throw fail();
    });
    try {
      const stat = await file.stat();
      if (!stat.isFile()) throw fail();
      let size = stat.size;
      if (format === "qcow2") {
        const header = Buffer.alloc(32);
        const { bytesRead } = await file.read(header, 0, header.length, 0);
        if (
          bytesRead !== header.length ||
          header.readUInt32BE(0) !== 0x514649fb ||
          ![2, 3].includes(header.readUInt32BE(4))
        )
          throw fail();
        const logical = header.readBigUInt64BE(24);
        if (logical > BigInt(Number.MAX_SAFE_INTEGER)) throw fail();
        size = Number(logical);
      }
      if (size !== gib * 1024 ** 3) throw fail();
    } finally {
      await file.close();
    }
  }
}
