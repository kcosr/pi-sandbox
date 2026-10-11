import { createHash } from "node:crypto";
import { chmod, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type * as FsPromises from "node:fs/promises";
import { validateHostTools, verifyHostTools } from "./host-tools.js";
import { createStateEnvironment } from "./cli.js";

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
  it("requires Darwin metadata and rejects it on Linux while keeping Linux defaults", async () => {
    await expect(verifyHostTools({}, [], "darwin")).rejects.toThrow();
    await expect(verifyHostTools({}, [], "linux")).resolves.toBeUndefined();
    await expect(
      verifyHostTools(
        { darwinProcessQuery: { path: "/trusted/query", sha256: "a".repeat(64) } },
        [],
        "linux",
      ),
    ).rejects.toThrow();
  });
  it.each([
    { e2fsprogsDirectory: "/tmp/../tools" },
    { e2fsprogsDirectory: "/tools:bad" },
    { darwinProcessQuery: { path: "/q", sha256: "invalid" } },
    { darwinProcessQuery: { path: "/q", sha256: "a".repeat(64), extra: true } },
  ])("rejects malformed trusted metadata %j", (v) => expect(() => validateHostTools(v)).toThrow());
  it("pins actual artifact content, executable mode, canonical placement and mount isolation", async () => {
    const root = await realpath(await mkdtemp("/tmp/query-tools-"));
    const file = path.join(root, "query");
    const content = "trusted artifact fixture";
    const sha256 = createHash("sha256").update(content).digest("hex");
    const options = { darwinProcessQuery: { path: file, sha256 } };
    try {
      await writeFile(file, content, { mode: 0o700 });
      const identity = await verifyHostTools(options, [], "darwin");
      expect(identity).toMatch(/^[a-f0-9]{64}$/u);
      await expect(verifyHostTools(options, [root], "darwin")).rejects.toThrow("overlap_mount");
      await expect(
        verifyHostTools(
          { darwinProcessQuery: { path: file, sha256: "0".repeat(64) } },
          [],
          "darwin",
        ),
      ).rejects.toThrow("digest_mismatch");
      await symlink(file, path.join(root, "alias"));
      await expect(
        verifyHostTools(
          { darwinProcessQuery: { path: path.join(root, "alias"), sha256 } },
          [],
          "darwin",
        ),
      ).rejects.toThrow();
      await chmod(file, 0o600);
      await expect(verifyHostTools(options, [], "darwin")).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
  it("appends only the explicit tools directory to the fixed launcher PATH", () => {
    expect(createStateEnvironment("/private/state", "/trusted/sbin").PATH).toBe(
      "/usr/bin:/bin:/usr/sbin:/sbin:/trusted/sbin",
    );
    expect(createStateEnvironment("/private/state").PATH).toBe("/usr/bin:/bin:/usr/sbin:/sbin");
  });
  it("binds disk content into cold identity and refuses a higher-priority selection", async () => {
    const root = await realpath(await mkdtemp("/tmp/disk-tools-"));
    try {
      for (const tool of ["resize2fs", "e2fsck"])
        await writeFile(path.join(root, tool), "tool fixture", { mode: 0o700 });
      const options = { e2fsprogsDirectory: root };
      const before = await verifyHostTools(options, [], "linux");
      await writeFile(path.join(root, "resize2fs"), "changed tool");
      expect(await verifyHostTools(options, [], "linux")).not.toBe(before);
      await expect(verifyHostTools(options, [root], "linux")).rejects.toThrow("overlap_mount");
      selection.conflict = true;
      await expect(verifyHostTools(options, [], "linux")).rejects.toThrow("selection_conflict");
    } finally {
      selection.conflict = false;
      await rm(root, { recursive: true, force: true });
    }
  });
});
