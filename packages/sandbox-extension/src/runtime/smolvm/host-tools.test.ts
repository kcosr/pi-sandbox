import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";
import { validateHostTools, verifyHostTools } from "./host-tools.js";
import { createSmolvmEnvironment } from "./registry.js";

const selection = vi.hoisted(() => ({ conflict: false }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof FsPromises>();
  const fixed =
    /^\/(?:opt\/homebrew\/opt\/e2fsprogs\/sbin|usr\/local\/opt\/e2fsprogs\/sbin|opt\/homebrew\/sbin|usr\/local\/sbin|sbin|usr\/sbin|usr\/bin|bin)\/(?:resize2fs|e2fsck)$/u;
  return {
    ...actual,
    lstat: (file: Parameters<typeof actual.lstat>[0]) => {
      if (!fixed.test(String(file))) return actual.lstat(file);
      if (selection.conflict) return Promise.resolve({});
      return Promise.reject(Object.assign(new Error("missing fixture prefix"), { code: "ENOENT" }));
    },
    realpath: (file: Parameters<typeof actual.realpath>[0]) =>
      fixed.test(String(file)) ? Promise.resolve("/different/tool") : actual.realpath(file),
  };
});

describe("trusted smolvm host tooling", () => {
  it("keeps disk tooling optional without adding a process observer", async () => {
    await expect(verifyHostTools({}, [])).resolves.toBeUndefined();
  });
  it.each(["/tmp/../tools", "/tools:bad", "/", "relative", "/tools\n"])(
    "rejects malformed directory %j",
    (e2fsprogsDirectory) => expect(() => validateHostTools({ e2fsprogsDirectory })).toThrow(),
  );
  it("appends only the explicit tools directory to the fixed launcher PATH", () => {
    expect(createSmolvmEnvironment("/trusted/sbin").PATH).toBe(
      "/usr/bin:/bin:/usr/sbin:/sbin:/trusted/sbin",
    );
    expect(createSmolvmEnvironment().PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  });
  it("binds disk content into cold identity and refuses a higher-priority selection", async () => {
    const root = await realpath(await mkdtemp("/tmp/disk-tools-"));
    try {
      for (const tool of ["resize2fs", "e2fsck"])
        await writeFile(path.join(root, tool), "tool fixture", { mode: 0o700 });
      const options = { e2fsprogsDirectory: root };
      const before = await verifyHostTools(options, []);
      await writeFile(path.join(root, "resize2fs"), "changed tool");
      expect(await verifyHostTools(options, [])).not.toBe(before);
      await expect(verifyHostTools(options, [root])).rejects.toThrow("overlap_mount");
      await symlink(root, root + "-alias");
      await expect(verifyHostTools({ e2fsprogsDirectory: root + "-alias" }, [])).rejects.toThrow();
      await rm(root + "-alias");
      await chmod(path.join(root, "resize2fs"), 0o600);
      await expect(verifyHostTools(options, [])).rejects.toThrow();
      await chmod(path.join(root, "resize2fs"), 0o722);
      await expect(verifyHostTools(options, [])).rejects.toThrow();
      await chmod(path.join(root, "resize2fs"), 0o700);
      selection.conflict = true;
      await expect(verifyHostTools(options, [])).rejects.toThrow("selection_conflict");
    } finally {
      selection.conflict = false;
      await rm(root, { recursive: true, force: true });
    }
  });
});
