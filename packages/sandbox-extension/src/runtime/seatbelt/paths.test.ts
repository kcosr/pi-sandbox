import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import type * as filesystem from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveSeatbeltDeniedPath } from "./paths.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof filesystem>();
  return { ...actual, realpath: vi.fn(actual.realpath) };
});

describe("Seatbelt denied path resolution", () => {
  let root: string;
  beforeEach(async () => {
    root = await realpath(await mkdtemp(path.join(tmpdir(), "seatbelt-paths-")));
    await mkdir(path.join(root, "directory"));
    await writeFile(path.join(root, "file"), "secret");
  });
  afterEach(async () => {
    vi.resetAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it.each(["directory/missing", "directory/missing/child"])(
    "checks the existing ancestor before skipping %s",
    async (target) => {
      // Simulate a filesystem canonicalization alias without relying on host case/Unicode rules.
      vi.mocked(realpath).mockResolvedValueOnce(path.join(root, "canonical-ancestor"));
      await expect(resolveSeatbeltDeniedPath(path.join(root, target))).rejects.toThrow(
        "sandbox_denied_path_not_canonical",
      );
      expect(realpath).toHaveBeenLastCalledWith(path.join(root, "directory"));
    },
  );

  it("admits regular files and directories, skipping absent leaves and parents", async () => {
    for (const name of ["directory", "file"])
      expect(await resolveSeatbeltDeniedPath(path.join(root, name))).toBe(path.join(root, name));
    for (const name of ["missing", "missing/child", "directory/missing"])
      expect(await resolveSeatbeltDeniedPath(path.join(root, name))).toBeUndefined();
  });

  it("rejects live and dangling symlinks, including ancestors of missing targets", async () => {
    await symlink(path.join(root, "directory"), path.join(root, "alias"));
    await symlink(path.join(root, "missing"), path.join(root, "dangling"));
    await symlink(path.join(root, "file"), path.join(root, "file-alias"));
    for (const name of ["alias", "alias/missing", "dangling", "dangling/child", "file-alias"])
      await expect(resolveSeatbeltDeniedPath(path.join(root, name))).rejects.toThrow(
        "sandbox_denied_path_not_canonical",
      );
  });

  it("rejects a regular file used as a parent", async () => {
    await expect(resolveSeatbeltDeniedPath(path.join(root, "file/missing"))).rejects.toThrow(
      "seatbelt_path_not_directory",
    );
  });

  it("rejects special files", async () => {
    const socket = path.join(root, "socket");
    const server = createServer();
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(socket, resolve);
    });
    try {
      await expect(resolveSeatbeltDeniedPath(socket)).rejects.toThrow(
        "seatbelt_denied_path_type_invalid",
      );
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it.skipIf(process.getuid?.() === 0)("does not swallow permission errors as missing", async () => {
    const directory = path.join(root, "directory");
    await chmod(directory, 0);
    try {
      await expect(
        resolveSeatbeltDeniedPath(path.join(directory, "missing")),
      ).rejects.toMatchObject({ code: "EACCES" });
    } finally {
      await chmod(directory, 0o700);
    }
  });
});
