import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import path from "node:path";
import { RELEASE_INVENTORY } from "./release-inventory.js";
import { SMOLVM_RELEASE_SHA256 } from "./release-pin.js";
export { SMOLVM_VERSION, SMOLVM_SOURCE_COMMIT, SMOLVM_RELEASE_SHA256 } from "./release-pin.js";

export async function fileSha256(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error("smolvm_expected_regular_file");
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      if (!Buffer.isBuffer(chunk)) throw new Error("smolvm_invalid_file_chunk");
      digest.update(chunk);
    }
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs)
      throw new Error("smolvm_file_changed_during_verification");
    return digest.digest("hex");
  } finally {
    await handle.close();
  }
}

/** Check the complete upstream runtime dependency tree before executing it. */
export async function verifySmolvmRuntime(executable: string): Promise<string> {
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("smolvm_requires_linux_x64");
  if (
    !path.isAbsolute(executable) ||
    (await realpath(executable)) !== executable ||
    path.basename(executable) !== "smolvm"
  )
    throw new Error("smolvm_runtime_path_invalid");
  const root = path.dirname(executable);
  const expected = new Map(
    RELEASE_INVENTORY.map(([name, type, identity]) => [name, { type, identity }]),
  );
  // Exact tree membership prevents an extra library or guest startup file from
  // acquiring authority outside the pinned inventory. Generated disk templates
  // live beside these trees and remain upstream-managed provisioning caches.
  async function walk(relative: string): Promise<void> {
    const entry = expected.get(relative);
    if (!entry) throw new Error(`smolvm_runtime_unexpected_entry:${relative}`);
    const file = path.join(root, relative);
    const stat = await lstat(file);
    if (entry.type === "directory") {
      if (!stat.isDirectory()) throw new Error(`smolvm_runtime_type_mismatch:${relative}`);
      const children = await readdir(file);
      if (children.length > expected.size) throw new Error("smolvm_runtime_inventory_exceeded");
      for (const child of children) await walk(`${relative}/${child}`);
    } else if (entry.type === "symlink") {
      if (!stat.isSymbolicLink() || (await readlink(file)) !== entry.identity)
        throw new Error(`smolvm_runtime_link_mismatch:${relative}`);
    } else if (!stat.isFile() || (await fileSha256(file)) !== entry.identity) {
      throw new Error(`smolvm_runtime_digest_mismatch:${relative}`);
    }
    expected.delete(relative);
  }
  for (const [name] of RELEASE_INVENTORY) if (!name.includes("/")) await walk(name);
  if (expected.size) throw new Error("smolvm_runtime_inventory_incomplete");
  await access(executable, constants.X_OK);
  await access(path.join(root, "smolvm-bin"), constants.X_OK);
  return SMOLVM_RELEASE_SHA256;
}
