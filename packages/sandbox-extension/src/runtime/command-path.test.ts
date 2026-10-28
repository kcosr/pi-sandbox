import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertCommandPathPlacement,
  canonicalizeCommandPathPrepend,
  snapshotCommandPathPrepend,
} from "./command-path.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "pi-command-path-")));
  temporaryDirectories.push(root);
  const cwd = join(root, "workspace");
  const tools = join(root, "tools");
  await Promise.all([mkdir(cwd), mkdir(tools)]);
  return { root, cwd, tools };
}

describe("command PATH syntax", () => {
  it("takes immutable syntax-only snapshots without requiring installed directories", () => {
    const input = ["/does-not-need-to-exist/libexec"];
    const snapshot = snapshotCommandPathPrepend(input);
    input[0] = "/other";
    expect(snapshot).toEqual(["/does-not-need-to-exist/libexec"]);
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(snapshotCommandPathPrepend(undefined)).toEqual([]);
    expect(snapshotCommandPathPrepend([])).toEqual([]);
  });

  it.each([
    null,
    "/opt/tools",
    [null],
    ["relative"],
    ["/"],
    ["/opt/tools/"],
    ["/opt//tools"],
    ["/opt/../tools"],
    ["/opt/./tools"],
    ["/opt/tools:/usr/bin"],
    ["/{{username}}/tools"],
    ["/opt/\n/tools"],
    ["/opt/\u200btools"],
    ["/opt/\ud800"],
    ["/opt/tools", "/opt/tools"],
    new Array(1),
    Array.from({ length: 65 }, (_, index) => `/tools/${index}`),
    [`/${"x".repeat(4096)}`],
    Array.from({ length: 5 }, (_, index) => `/${index}${"x".repeat(4094)}`),
  ])("rejects malformed or unbounded directory lists: %j", (input) => {
    expect(() => snapshotCommandPathPrepend(input)).toThrow("sandbox_command_path_invalid");
  });
});

describe("command PATH placement", () => {
  it("rejects writable workspace contents but permits parents and read-only workspaces", () => {
    for (const backend of ["bubblewrap", "seatbelt", "direct"] as const) {
      for (const prefix of ["/work/project", "/work/project/bin"])
        expect(() =>
          assertCommandPathPlacement([prefix], { backend, cwd: "/work/project" }),
        ).toThrow("workspace_overlap");
      expect(() =>
        assertCommandPathPlacement(["/work"], { backend, cwd: "/work/project" }),
      ).not.toThrow();
      expect(() =>
        assertCommandPathPlacement(["/work/project/bin"], {
          backend,
          cwd: "/work/project",
          cwdWritable: false,
        }),
      ).not.toThrow();
    }
  });

  it("rejects Bubblewrap private locations and both directions of mask overlap", () => {
    for (const prefix of ["/tmp/tools", "/run/tools", "/proc/self", "/sys/tools", "/dev/tools"])
      expect(() =>
        assertCommandPathPlacement([prefix], { backend: "bubblewrap", cwd: "/work" }),
      ).toThrow("unavailable");
    for (const hidden of ["/opt", "/opt/tools", "/opt/tools/private"])
      expect(() =>
        assertCommandPathPlacement(["/opt/tools"], {
          backend: "bubblewrap",
          cwd: "/work",
          hiddenPaths: [hidden],
        }),
      ).toThrow("unavailable");
    expect(() =>
      assertCommandPathPlacement(["/opt/tools"], {
        backend: "bubblewrap",
        cwd: "/work",
        hiddenPaths: ["/opt/tools-other"],
      }),
    ).not.toThrow();
  });

  it("applies Seatbelt denial and private-scratch checks without inventing Linux overlays", () => {
    for (const denied of ["/opt", "/opt/tools", "/opt/tools/private"])
      expect(() =>
        assertCommandPathPlacement(["/opt/tools"], {
          backend: "seatbelt",
          cwd: "/work",
          deniedPaths: [denied],
        }),
      ).toThrow("unavailable");
    expect(() =>
      assertCommandPathPlacement(["/private/tmp/runtime/home"], {
        backend: "seatbelt",
        cwd: "/work",
        privatePaths: ["/private/tmp/runtime"],
      }),
    ).toThrow("unavailable");
    for (const backend of ["seatbelt", "direct"] as const)
      expect(() =>
        assertCommandPathPlacement(["/tmp/tools"], { backend, cwd: "/work" }),
      ).not.toThrow();
  });
});

describe("command PATH filesystem preparation", () => {
  it("canonicalizes managed aliases once and rejects aliases in trusted constructors", async () => {
    const { root, cwd, tools } = await fixture();
    const alias = join(root, "alias");
    await symlink(tools, alias);
    const context = { backend: "direct", cwd } as const;
    const prepared = await canonicalizeCommandPathPrepend([alias], context);
    expect(prepared).toEqual([tools]);
    expect(Object.isFrozen(prepared)).toBe(true);
    await expect(canonicalizeCommandPathPrepend([alias], context, true)).rejects.toThrow(
      "not_canonical",
    );
    await expect(canonicalizeCommandPathPrepend([alias, tools], context)).rejects.toThrow(
      "duplicate",
    );
    await expect(canonicalizeCommandPathPrepend(prepared, context, true)).resolves.toEqual([tools]);
  });

  it("refuses unavailable, non-directory and unsearchable entries", async () => {
    const { root, cwd, tools } = await fixture();
    const context = { backend: "direct", cwd } as const;
    await expect(
      canonicalizeCommandPathPrepend([join(root, "missing")], context),
    ).rejects.toThrow();
    const regular = join(root, "regular");
    await writeFile(regular, "not a directory");
    await expect(canonicalizeCommandPathPrepend([regular], context)).rejects.toThrow(
      "not_directory",
    );
    if (process.getuid?.() !== 0) {
      await chmod(tools, 0o600);
      try {
        await expect(canonicalizeCommandPathPrepend([tools], context)).rejects.toThrow();
      } finally {
        await chmod(tools, 0o700);
      }
    }
  });

  it("checks both authored and canonical paths against workspace and denial boundaries", async () => {
    const { root, cwd, tools } = await fixture();
    const inside = join(cwd, "tools");
    const intoWorkspace = join(root, "into-workspace");
    await Promise.all([symlink(tools, inside), symlink(cwd, intoWorkspace)]);
    for (const prefix of [inside, intoWorkspace])
      await expect(
        canonicalizeCommandPathPrepend([prefix], { backend: "direct", cwd }),
      ).rejects.toThrow("workspace_overlap");
    const alias = join(root, "alias");
    await symlink(tools, alias);
    for (const denied of [alias, tools])
      await expect(
        canonicalizeCommandPathPrepend([alias], {
          backend: "seatbelt",
          cwd,
          deniedPaths: [denied],
        }),
      ).rejects.toThrow("unavailable");
  });

  it("captures mutable arrays and placement context before filesystem awaits", async () => {
    const { cwd, tools } = await fixture();
    const input = [tools];
    const deniedPaths: string[] = [];
    const context = { backend: "seatbelt" as const, cwd, deniedPaths };
    const pending = canonicalizeCommandPathPrepend(input, context);
    input[0] = cwd;
    deniedPaths.push(tools);
    context.cwd = tools;
    await expect(pending).resolves.toEqual([tools]);
  });
});
