// Adapted from the MIT-licensed agent-sandbox packed-image gate at f414fef.
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import type { SmolvmResources } from "./options.js";
import { fileSha256, SMOLVM_VERSION } from "./runtime-release.js";

function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
function emptyArray(value: unknown): boolean {
  return value === undefined || (Array.isArray(value) && value.length === 0);
}
/** A locally provisioned, digest-pinned plain VM pack, never imported authority. */
export async function validateSmolvmPack(
  image: string,
  sha256: string,
  resources: SmolvmResources,
): Promise<void> {
  if ((await fileSha256(image)) !== sha256) throw new Error("smolvm_image_digest_mismatch");
  const file = await open(image, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const { size, nlink } = await file.stat();
    if (nlink !== 1 || size < 64) throw new Error("smolvm_pack_invalid");
    const footer = Buffer.alloc(64);
    if (
      (await file.read(footer, 0, 64, size - 64)).bytesRead !== 64 ||
      footer.subarray(0, 8).toString() !== "SMOLPACK" ||
      footer.readUInt32LE(8) !== 1
    )
      throw new Error("smolvm_pack_invalid");
    const offset = Number(footer.readBigUInt64LE(36));
    const length = Number(footer.readBigUInt64LE(44));
    if (
      !Number.isSafeInteger(offset) ||
      !Number.isSafeInteger(length) ||
      offset < 0 ||
      length < 2 ||
      length > 1048576 ||
      offset + length !== size - 64
    )
      throw new Error("smolvm_pack_invalid");
    const bytes = Buffer.alloc(length);
    if ((await file.read(bytes, 0, length, offset)).bytesRead !== length)
      throw new Error("smolvm_pack_invalid");
    const m: unknown = JSON.parse(bytes.toString());
    const allowed = [
      "mode",
      "image",
      "digest",
      "platform",
      "cpus",
      "mem",
      "image_size",
      "network",
      "gpu",
      "cuda",
      "host_platform",
      "created",
      "smolvm_version",
      "assets",
      "entrypoint",
      "cmd",
      "env",
      "checkpoint",
      "workdir",
      "user",
      "secret_refs",
    ];
    if (
      !object(m) ||
      Object.keys(m).some((key) => !allowed.includes(key)) ||
      m.mode !== "vm" ||
      m.platform !== "linux/amd64" ||
      m.host_platform !== "linux/amd64" ||
      m.smolvm_version !== SMOLVM_VERSION ||
      m.network !== false ||
      m.gpu !== false ||
      m.cuda !== false
    )
      throw new Error("smolvm_pack_requires_plain_offline_vm");
    if (
      ["entrypoint", "cmd", "env"].some((key) => !emptyArray(m[key])) ||
      ["checkpoint", "workdir", "user"].some((key) => m[key] !== undefined && m[key] !== null) ||
      (m.secret_refs !== undefined &&
        (!object(m.secret_refs) || Object.keys(m.secret_refs).length !== 0))
    )
      throw new Error("smolvm_pack_imported_authority");
    const assets = m.assets;
    const assetKeys = [
      "libraries",
      "agent_rootfs",
      "layers",
      "storage_template",
      "storage_logical_size",
      "overlay_template",
      "overlay_logical_size",
      "workspace_seed",
    ];
    if (
      !object(assets) ||
      Object.keys(assets).some((key) => !assetKeys.includes(key)) ||
      !Array.isArray(assets.layers) ||
      assets.layers.length ||
      (assets.workspace_seed !== undefined && assets.workspace_seed !== null)
    )
      throw new Error("smolvm_pack_assets_invalid");
    for (const [disk, filename, capacity] of [
      ["storage", "storage.ext4", resources.storageGiB],
      ["overlay", "overlay.raw", resources.overlayGiB],
    ] as const) {
      const template = assets[`${disk}_template`];
      const logical = assets[`${disk}_logical_size`];
      if (
        !object(template) ||
        Object.keys(template).sort().join(",") !== "path,size" ||
        template.path !== filename ||
        typeof template.size !== "number" ||
        !Number.isSafeInteger(template.size) ||
        template.size <= 0 ||
        typeof logical !== "number" ||
        !Number.isSafeInteger(logical) ||
        logical <= 0 ||
        template.size > logical ||
        logical > capacity * 1024 ** 3
      )
        throw new Error("smolvm_pack_disk_capacity_invalid");
    }
  } finally {
    await file.close();
  }
}
