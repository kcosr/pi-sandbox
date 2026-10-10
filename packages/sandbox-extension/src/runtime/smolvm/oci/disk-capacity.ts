import { lstat } from "node:fs/promises";
import path from "node:path";
import type { SmolvmOciFamilyOptions } from "./types.js";

/** Internal post-start admission gate. A successful CLI exit must not silently
 * retain larger template disks when host resize prerequisites are unavailable. */
export async function verifyOciRawDiskCapacity(
  directory: string,
  resources: SmolvmOciFamilyOptions["resources"],
): Promise<void> {
  for (const [name, gib] of [
    ["storage.raw", resources.storageGiB],
    ["overlay.raw", resources.overlayGiB],
  ] as const) {
    const file = await lstat(path.join(directory, name));
    if (!file.isFile() || file.size !== gib * 1024 ** 3)
      throw new Error(`smolvm_oci_${name}_capacity_mismatch`);
  }
}
