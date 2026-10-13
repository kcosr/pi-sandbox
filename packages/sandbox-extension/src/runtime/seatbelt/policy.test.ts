import { describe, expect, it } from "vitest";
import { buildSeatbeltProfile, type SeatbeltPolicy } from "./policy.js";
import type { CanonicalSeatbeltDirectory } from "./paths.js";

// Synthetic canonical paths keep generator tests pure. Realpath is tested on
// existing directories in the native suite; this cast is never a launch helper.
const directory = (value: string) => value as CanonicalSeatbeltDirectory;
const baseline: SeatbeltPolicy = {
  workspace: directory("/work/ancestor/workspace"),
  workspaceWritable: true,
  temporaryDirectories: [directory("/session/temp")],
  deniedDirectories: [directory("/work/ancestor"), directory("/work/ancestor/workspace/a/secret")],
  networkMode: "none",
};

describe("Seatbelt profile generation", () => {
  it("is deterministic, immutable and parameterizes all paths", () => {
    const input = {
      ...baseline,
      deniedDirectories: [...baseline.deniedDirectories].reverse(),
    };
    const first = buildSeatbeltProfile(baseline);
    expect(buildSeatbeltProfile(input)).toEqual(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(Object.isFrozen(first.parameters)).toBe(true);
    expect(first.profile).not.toContain(baseline.workspace);
    expect(Object.values(first.parameters)).toContain("/work/ancestor/workspace/a");
    expect(first.profile).toContain("(deny file-write-unlink");
    expect(first.profile).toContain("(require-any (require-not");
    expect(first.profile).toContain("(deny default)");
    expect(first.profile).toContain("(allow signal (target same-sandbox))");
    expect(first.profile).not.toContain("(allow default)");
  });

  it.each(["none", "host"] as const)(
    "fixes AppleEvents/Mach restrictions in %s mode",
    (networkMode) => {
      const { profile } = buildSeatbeltProfile({ ...baseline, networkMode });
      expect(profile).toContain("(deny appleevent-send mach-lookup mach-register)");
      expect(profile).toContain("(deny process-info*)");
      expect(profile).toContain("(allow process-info-pidinfo (target self))");
      expect(profile).toContain('(deny sysctl-read (sysctl-name-prefix "kern.proc"))');
      expect(profile).toContain(networkMode === "host" ? "(allow network*)" : "(deny network*)");
      expect(profile).not.toContain("(allow mach-");
      expect(profile).not.toContain("(allow appleevent-");
    },
  );

  it("keeps quotes, backslashes, spaces and Unicode out of SBPL source", () => {
    const workspace = directory('/work/space 雪\\") (allow default) ;');
    const result = buildSeatbeltProfile({ ...baseline, workspace, deniedDirectories: [] });
    expect(Object.values(result.parameters)).toContain(workspace);
    expect(result.profile).not.toContain("allow default");
  });

  it("removes only the workspace write grant in read-only mode", () => {
    const result = buildSeatbeltProfile({ ...baseline, workspaceWritable: false });
    const key = Object.entries(result.parameters).find(
      ([, path]) => path === baseline.workspace,
    )![0];
    expect(result.profile).not.toContain(`(allow file-write* (subpath (param "${key}"))`);
    expect(result.profile.match(/\(allow file-write\*/gu)).toHaveLength(1);
  });

  it.each([
    "/",
    "/tmp",
    "/tmp/a",
    "/var/a",
    "/private/tmp",
    "/usr/bin",
    "/work/../secret",
    "/work/",
    "/work/\0",
    "/work/\n",
    "/work/\ud800",
  ])("rejects invalid/reserved path %j", (value) => {
    expect(() => buildSeatbeltProfile({ ...baseline, workspace: directory(value) })).toThrow();
  });

  it("rejects protected workspace equality and overlapping scratch authority", () => {
    expect(() =>
      buildSeatbeltProfile({ ...baseline, deniedDirectories: [baseline.workspace] }),
    ).toThrow("seatbelt_workspace_denied");
    for (const path of [
      baseline.workspace,
      "/work",
      "/work/ancestor/elsewhere",
      "/session/temp/subdir",
    ]) {
      expect(() =>
        buildSeatbeltProfile({
          ...baseline,
          temporaryDirectories: [...baseline.temporaryDirectories, directory(path)],
        }),
      ).toThrow("seatbelt_temporary_directory_overlap");
    }
  });

  it("rejects private system trees and shared temporary roots as writable grants", () => {
    for (const value of [
      "/private",
      "/private/etc",
      "/private/etc/ssh",
      "/private/var",
      "/private/var/root",
      "/private/var/db",
      "/private/var/log",
      "/private/other",
      "/private/tmp",
      "/private/var/tmp",
      "/private/var/folders",
      "/private/tmp-other/session",
      "/private/var/tmp-other/session",
      "/private/var/folders-other/session",
    ]) {
      expect(
        () => buildSeatbeltProfile({ ...baseline, workspace: directory(value) }),
        value,
      ).toThrow("seatbelt_path_reserved");
      expect(
        () => buildSeatbeltProfile({ ...baseline, temporaryDirectories: [directory(value)] }),
        value,
      ).toThrow("seatbelt_path_reserved");
    }
  });

  it("admits only subdirectories of the canonical private temporary roots for writes", () => {
    for (const root of ["/private/tmp", "/private/var/tmp", "/private/var/folders"]) {
      const result = buildSeatbeltProfile({
        ...baseline,
        workspace: directory(`${root}/session/workspace`),
        temporaryDirectories: [directory(`${root}/session/temp`)],
      });
      expect(result.profile.match(/\(allow file-write\*/gu)).toHaveLength(2);
      expect(Object.values(result.parameters)).toContain(`${root}/session/workspace`);
      expect(Object.values(result.parameters)).toContain(`${root}/session/temp`);
    }
  });

  it("keeps sensitive canonical private directories available as read denials", () => {
    const deniedDirectories = [
      "/private",
      "/private/etc",
      "/private/var/root",
      "/private/var/db",
      "/private/tmp",
      "/private/var/tmp",
      "/private/var/folders",
    ].map(directory);
    const result = buildSeatbeltProfile({ ...baseline, deniedDirectories });
    for (const value of deniedDirectories)
      expect(Object.values(result.parameters)).toContain(value);
    expect(result.profile).toContain("(require-not (subpath");
  });

  it.each(["/Users", "/Volumes", "/Library"])(
    "permits %s as a denial ancestor without granting its whole tree",
    (root) => {
      const workspace = directory(`${root}/fixture/workspace`);
      const deniedDirectories = [directory(root), directory(`${workspace}/private`)];
      const result = buildSeatbeltProfile({ ...baseline, workspace, deniedDirectories });
      const key = Object.entries(result.parameters).find(([, value]) => value === root)![0];
      expect(result.profile).toContain(`(require-any (require-not (subpath (param "${key}")))`);
      expect(result.profile).not.toContain(`(allow file-write* (subpath (param "${key}"))`);
      for (const workspaceWritable of [true, false]) {
        expect(() =>
          buildSeatbeltProfile({ ...baseline, workspace: directory(root), workspaceWritable }),
        ).toThrow("seatbelt_path_reserved");
      }
      expect(() =>
        buildSeatbeltProfile({ ...baseline, temporaryDirectories: [directory(root)] }),
      ).toThrow("seatbelt_path_reserved");
    },
  );

  it("does not reject a read-only private workspace merely because writes there are unsafe", () => {
    for (const value of ["/private/etc", "/private/var/root", "/private/var/db"]) {
      const result = buildSeatbeltProfile({
        ...baseline,
        workspace: directory(value),
        workspaceWritable: false,
      });
      expect(Object.values(result.parameters)).toContain(value);
      expect(result.profile.match(/\(allow file-write\*/gu)).toHaveLength(1);
    }
  });

  it("rejects unknown authority switches and invalid enum/boolean/array inputs", () => {
    for (const patch of [
      { appleEvents: true },
      { profile: "(allow default)" },
      { environment: {} },
      { networkMode: "proxy" },
      { workspaceWritable: undefined },
      { temporaryDirectories: null },
      { deniedDirectories: "/secret" },
    ]) {
      expect(() => buildSeatbeltProfile({ ...baseline, ...patch } as SeatbeltPolicy)).toThrow();
    }
  });

  it("bounds path count, path bytes and total generated policy bytes", () => {
    expect(() =>
      buildSeatbeltProfile({
        ...baseline,
        deniedDirectories: Array.from({ length: 65 }, (_, i) => directory(`/deny/${i}`)),
      }),
    ).toThrow();
    expect(() =>
      buildSeatbeltProfile({ ...baseline, workspace: directory(`/work/${"x".repeat(4096)}`) }),
    ).toThrow();
    expect(() =>
      buildSeatbeltProfile({
        ...baseline,
        deniedDirectories: Array.from({ length: 64 }, (_, i) =>
          directory(`/deny/${i}/${"x".repeat(2000)}`),
        ),
      }),
    ).toThrow("seatbelt_profile_too_large");
  });
});
