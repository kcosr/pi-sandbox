import { createHash } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { validateSmolvmOptions } from "./options.js";
import { validateSmolvmPack } from "./pack.js";
import { removeStoppedPrivateState } from "./private-state.js";

const resources = { cpus: 1, memoryMiB: 512, storageGiB: 1, overlayGiB: 1 };
const options = {
  cwd: "/projects/example",
  smolvmPath: "/opt/smolvm/smolvm",
  imagePath: "/images/tools.smolmachine",
  imageSha256: "a".repeat(64),
  stateDirectory: "/private-state",
  resources,
};
function manifest() {
  return {
    mode: "vm",
    platform: "linux/amd64",
    host_platform: "linux/amd64",
    smolvm_version: "1.25.4",
    network: false,
    gpu: false,
    cuda: false,
    assets: {
      libraries: [],
      agent_rootfs: { path: "agent-rootfs.tar", size: 1 },
      layers: [],
      storage_template: { path: "storage.ext4", size: 1 },
      storage_logical_size: 1073741824,
      overlay_template: { path: "overlay.raw", size: 1 },
      overlay_logical_size: 1073741824,
    },
  };
}
async function fixture(value: unknown, action: (file: string, digest: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), "smol-pack-test-"));
  try {
    const data = Buffer.from(JSON.stringify(value));
    const footer = Buffer.alloc(64);
    footer.write("SMOLPACK");
    footer.writeUInt32LE(1, 8);
    footer.writeBigUInt64LE(BigInt(data.length), 44);
    const bytes = Buffer.concat([data, footer]);
    const file = path.join(root, "image.smolmachine");
    await writeFile(file, bytes);
    await action(file, createHash("sha256").update(bytes).digest("hex"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe("packed smolvm admission", () => {
  it("validates resources and rejects project/control overlap and ambient hooks", () => {
    expect(() => validateSmolvmOptions(options)).not.toThrow();
    for (const patch of [
      { cwd: "/" },
      { cwd: "/opt" },
      { stateDirectory: "/projects/example/state" },
      { environment: { NODE_OPTIONS: "--require=/host.js" } },
      { resources: { ...resources, memoryMiB: 128 } },
      { resources: { ...resources, cpus: 33 } },
      { limits: { maximumInputBytes: 0 } },
    ])
      expect(() => validateSmolvmOptions({ ...options, ...patch })).toThrow();
  });
  it("admits a pinned plain manifest and rejects a different digest", async () => {
    await fixture(manifest(), async (file, digest) => {
      await expect(validateSmolvmPack(file, digest, resources)).resolves.toBeUndefined();
      await expect(validateSmolvmPack(file, "0".repeat(64), resources)).rejects.toThrow("digest");
    });
  });
  it.each([
    { network: true },
    { gpu: true },
    { cuda: true },
    { mode: "oci" },
    { smolvm_version: "1.23.1" },
    { host_platform: "darwin/arm64" },
    { cmd: ["/bin/evil"] },
    { entrypoint: ["/bin/evil"] },
    { env: ["SECRET=value"] },
    { checkpoint: {} },
    { user: "root" },
    { workdir: "/workspace" },
    { secret_refs: { key: "HOST_SECRET" } },
    { future_authority: true },
  ])("rejects imported authority %j", async (patch) => {
    await fixture({ ...manifest(), ...patch }, async (file, digest) => {
      await expect(validateSmolvmPack(file, digest, resources)).rejects.toThrow();
    });
  });
  it("rejects layers, workspace seeds and oversized disks", async () => {
    for (const patch of [
      { layers: [{}] },
      { workspace_seed: {} },
      { storage_logical_size: 2 * 1073741824 },
    ]) {
      const m = manifest();
      await fixture({ ...m, assets: { ...m.assets, ...patch } }, async (file, digest) => {
        await expect(validateSmolvmPack(file, digest, resources)).rejects.toThrow();
      });
    }
  });
  it("removes stopped immutable caches without traversing outside symlinks", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "smol-state-test-"));
    const outside = await mkdtemp(path.join(tmpdir(), "smol-outside-test-"));
    try {
      const immutable = path.join(root, "cache");
      await mkdir(immutable);
      await writeFile(path.join(immutable, "disk"), "cache");
      await writeFile(path.join(outside, "keep"), "outside");
      await chmod(outside, 0o500);
      await symlink(outside, path.join(root, "outside"));
      await chmod(immutable, 0o500);
      await removeStoppedPrivateState(root);
      expect(await readFile(path.join(outside, "keep"), "utf8")).toBe("outside");
      expect((await stat(outside)).mode & 0o777).toBe(0o500);
    } finally {
      await chmod(outside, 0o700);
      await rm(outside, { recursive: true, force: true });
      await rm(root, { recursive: true, force: true });
    }
  });
});
