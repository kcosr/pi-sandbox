import { afterEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertToolBundlePlacement,
  snapshotToolBundle,
  validateToolBundle,
} from "./tool-bundle.js";
import { resolveDirectToolCommands } from "./direct-executor.js";
import { TOOL_COMMAND_NAMES, type ToolBundle } from "./contracts.js";
import { buildBubblewrapArguments } from "./bubblewrap-policy.js";
import { validateSeatbeltOptions } from "./seatbelt/options.js";
import { LINUX_TOOL_COMMANDS } from "./tool-commands.js";

const owned: string[] = [];
afterEach(async () => {
  await Promise.all(owned.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "pi-bundle-' space-")));
  owned.push(root);
  await mkdir(path.join(root, "bin"));
  const command = path.join(root, "bin", "cat");
  await writeFile(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return { root, commands: { cat: command } };
}

describe("trusted build-selected tool bundle", () => {
  it("protects a host-only bundle while preserving all default executor command paths", async () => {
    const fixtureBundle = await fixture();
    await rm(fixtureBundle.commands.cat);
    await writeFile(path.join(fixtureBundle.root, "bin", "rg"), "#!/bin/sh\nexit 0\n", {
      mode: 0o755,
    });
    const bundle = snapshotToolBundle({ root: fixtureBundle.root, commands: {} })!;
    await validateToolBundle(bundle);
    expect(await resolveDirectToolCommands("linux", bundle)).toEqual(LINUX_TOOL_COMMANDS);
    expect(Object.isFrozen(bundle.commands)).toBe(true);
    expect(() => assertToolBundlePlacement(bundle, bundle.root, true)).toThrow(
      "sandbox_tool_bundle_workspace_overlap",
    );
    expect(() =>
      assertToolBundlePlacement(bundle, "/work", true, [path.join(bundle.root, "bin")]),
    ).toThrow("sandbox_tool_bundle_path_unavailable");
    await rm(path.join(bundle.root, "bin"), { recursive: true });
    await expect(validateToolBundle(bundle)).rejects.toThrow();
  });

  it("snapshots metadata and overlays selected commands without resolving their system alternatives", async () => {
    const bundle = await fixture();
    const selected = snapshotToolBundle(bundle)!;
    bundle.commands.cat = path.join(bundle.root, "missing");
    const linux = await resolveDirectToolCommands("linux", selected);
    expect(linux.cat).toBe(path.join(bundle.root, "bin", "cat"));
    expect(linux.sh).toBe("/bin/sh");
    expect(Object.isFrozen(linux)).toBe(true);
    const allSelected: ToolBundle = {
      root: selected.root,
      commands: Object.fromEntries(TOOL_COMMAND_NAMES.map((name) => [name, selected.commands.cat])),
    };
    const darwin = await resolveDirectToolCommands("darwin", allSelected);
    expect(Object.values(darwin).every((value) => value === selected.commands.cat)).toBe(true);
  });

  it("fails selected missing, non-executable and aliased paths without fallback", async () => {
    const bundle = await fixture();
    await expect(
      resolveDirectToolCommands("linux", {
        ...bundle,
        commands: { cat: path.join(bundle.root, "bin", "missing") },
      }),
    ).rejects.toMatchObject({ code: "sandbox_start_failed" });
    const alias = path.join(bundle.root, "bin", "alias");
    await symlink(bundle.commands.cat, alias);
    await expect(validateToolBundle({ ...bundle, commands: { cat: alias } })).rejects.toThrow(
      "sandbox_tool_bundle_command_invalid",
    );
    await chmod(bundle.commands.cat, 0o644);
    await expect(resolveDirectToolCommands("linux", bundle)).rejects.toMatchObject({
      code: "sandbox_start_failed",
    });
  });

  it("rejects invalid metadata and paths outside the selected root", () => {
    for (const bundle of [
      null,
      { root: "/tools:other", commands: { cat: "/tools:other/bin/cat" } },
      { root: "/tools", commands: { cat: "/bin/cat" } },
      { root: "/tools", commands: { other: "/tools/bin/other" } },
      { root: "/tools", commands: { cat: "/tools/../cat" } },
      { root: "/tools", commands: { cat: "/tools/bin/cat" }, source: "runtime" },
    ])
      expect(() => snapshotToolBundle(bundle as ToolBundle)).toThrow();
  });

  it("protects whole bundles against writable workspaces, masks and denials", () => {
    const bundle = { root: "/opt/tools", commands: { cat: "/opt/tools/bin/cat" } };
    for (const cwd of ["/opt", "/opt/tools", "/opt/tools/project"])
      expect(() => assertToolBundlePlacement(bundle, cwd, true)).toThrow(
        "sandbox_tool_bundle_workspace_overlap",
      );
    expect(() => assertToolBundlePlacement(bundle, "/opt/tools/project", false)).not.toThrow();
    for (const denied of ["/opt", "/opt/tools/lib"])
      expect(() =>
        validateSeatbeltOptions({ cwd: "/work", toolBundle: bundle, deniedPaths: [denied] }),
      ).toThrow("sandbox_tool_bundle_path_unavailable");
    expect(() =>
      buildBubblewrapArguments(
        "/work",
        ["/bin/sh"],
        "none",
        {},
        true,
        [{ target: "/opt/tools/lib", kind: "directory" }],
        bundle,
      ),
    ).toThrow("sandbox_tool_bundle_path_unavailable");
    const args = buildBubblewrapArguments("/work", ["/bin/sh"], "none", {}, true, [], bundle);
    const position = args.indexOf("PATH");
    expect(args[position + 1]).toMatch(/^\/opt\/tools\/bin:/u);
  });
});
