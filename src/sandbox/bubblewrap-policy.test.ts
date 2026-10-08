import { describe, expect, it } from "vitest";
import {
  BUBBLEWRAP_FILE_MASK_FIRST_FD,
  BUBBLEWRAP_SECCOMP_FD,
  assertSandboxCwd,
  buildBubblewrapArguments,
  describeBubblewrapMounts,
  planHiddenPaths,
  safeSandboxEnvironment,
} from "./bubblewrap-policy.js";

describe("Bubblewrap policy", () => {
  it("orders private masks around CWD restoration and freezes them non-recursively", () => {
    const hidden = [
      "/srv/runs/a/private/nested",
      "/srv/runs/b",
      "/srv/runs/a/private",
      "/srv/runs",
      "/srv/transcripts",
      "/srv/runs/a/..cache",
    ];
    const masks = planHiddenPaths("/srv/runs/a", hidden);
    expect(masks).toEqual({
      beforeCwd: ["/srv/runs", "/srv/transcripts"],
      afterCwd: ["/srv/runs/a/..cache", "/srv/runs/a/private"],
    });
    const args = buildBubblewrapArguments(
      "/srv/runs/a",
      ["/bin/true"],
      "none",
      {},
      true,
      hidden.map((target) => ({ target, kind: "directory" })),
    );
    const cwdMount = sequenceIndex(args, ["--bind", "/srv/runs/a", "/srv/runs/a"]);
    expect(sequenceIndex(args, ["--tmpfs", "/srv/runs"])).toBeLessThan(cwdMount);
    expect(sequenceIndex(args, ["--tmpfs", "/srv/runs/a/private"])).toBeGreaterThan(cwdMount);
    expect(sequenceIndex(args, ["--remount-ro", "/srv/runs"])).toBeGreaterThan(
      sequenceIndex(args, ["--tmpfs", "/srv/runs/a/private"]),
    );
    expect(planHiddenPaths("/srv/run", ["/srv/runs"])).toEqual({
      beforeCwd: ["/srv/runs"],
      afterCwd: [],
    });
    expect(describeBubblewrapMounts("/srv/runs/a", true, hidden)).toContainEqual({
      target: "/srv/runs/a/private",
      access: "read-only",
      content: "hidden host path (mask if present at startup)",
    });
  });

  it.each([
    "/",
    "relative",
    "/srv/runs/a",
    "/proc",
    "/sys",
    "/dev/shm",
    "/run",
    "/run/pi-sandbox",
    "/tmp",
    "/srv/../runs",
  ])("rejects an unsafe hidden path: %s", (target) => {
    expect(() =>
      buildBubblewrapArguments("/srv/runs/a", ["/bin/true"], "none", {}, true, [
        { target, kind: "directory" },
      ]),
    ).toThrow();
  });

  it("uses separate empty-data FDs for file masks and restores masks beneath a hidden CWD ancestor", () => {
    const args = buildBubblewrapArguments("/srv/runs/a", ["/bin/true"], "none", {}, true, [
      { target: "/srv/runs/a/token", kind: "file" },
      { target: "/srv/runs/b/token", kind: "file" },
      { target: "/srv/runs", kind: "directory" },
      { target: "/srv/token", kind: "file" },
    ]);
    const cwdMount = sequenceIndex(args, ["--bind", "/srv/runs/a", "/srv/runs/a"]);
    expect(
      sequenceIndex(args, ["--ro-bind-data", String(BUBBLEWRAP_FILE_MASK_FIRST_FD), "/srv/token"]),
    ).toBeLessThan(cwdMount);
    expect(
      sequenceIndex(args, [
        "--ro-bind-data",
        String(BUBBLEWRAP_FILE_MASK_FIRST_FD + 1),
        "/srv/runs/a/token",
      ]),
    ).toBeGreaterThan(cwdMount);
    expect(args).not.toContain("/srv/runs/b/token");
    expect(hasSequence(args, ["--tmpfs", "/srv/runs/a/token"])).toBe(false);
    expect(hasSequence(args, ["--remount-ro", "/srv/runs/a/token"])).toBe(false);
  });

  it("preserves absolute paths and overlays only the launch directory writable", () => {
    const args = buildBubblewrapArguments("/home/person/project", ["/bin/echo", "hello"]);

    expect(hasSequence(args, ["--ro-bind", "/", "/"])).toBe(true);
    expect(hasSequence(args, ["--bind", "/home/person/project", "/home/person/project"])).toBe(
      true,
    );
    expect(hasSequence(args, ["--chdir", "/home/person/project"])).toBe(true);
    expect(args).not.toContain("--share-net");
    expect(hasSequence(args, ["--seccomp", String(BUBBLEWRAP_SECCOMP_FD)])).toBe(true);
  });

  it.each(["/home/person/project", "/tmp/project"])(
    "explicitly overlays read-only CWD after private mounts: %s",
    (cwd) => {
      const args = buildBubblewrapArguments(cwd, ["/bin/true"], "none", {}, false);
      const cwdMount = sequenceIndex(args, ["--ro-bind", cwd, cwd]);
      expect(cwdMount).toBeGreaterThan(sequenceIndex(args, ["--tmpfs", "/tmp"]));
      expect(cwdMount).toBeGreaterThan(sequenceIndex(args, ["--tmpfs", "/run"]));
      expect(hasSequence(args, ["--bind", cwd, cwd])).toBe(false);
      expect(describeBubblewrapMounts(cwd, false)).toContainEqual({
        target: cwd,
        access: "read-only",
        content: "host launch directory",
      });
    },
  );

  it("rejects read-only /tmp instead of masking writable private temporary storage", () => {
    expect(() => buildBubblewrapArguments("/tmp", ["/bin/true"], "none", {}, false)).toThrow(
      "sandbox_cwd_masks_private_tmp",
    );
    expect(() => describeBubblewrapMounts("/tmp", false)).toThrow("sandbox_cwd_masks_private_tmp");
    expect(() => buildBubblewrapArguments("/tmp", ["/bin/true"])).not.toThrow();
    expect(describeBubblewrapMounts("/tmp").filter((mount) => mount.target === "/tmp")).toEqual([
      { target: "/tmp", access: "read/write", content: "host launch directory" },
    ]);
  });

  it("creates private pseudo-filesystems and locks down namespace authority", () => {
    const args = buildBubblewrapArguments("/home/person/project", ["/bin/true"]);

    for (const option of [
      "--unshare-all",
      "--unshare-user",
      "--disable-userns",
      "--assert-userns-disabled",
      "--die-with-parent",
      "--new-session",
      "--clearenv",
    ]) {
      expect(args).toContain(option);
    }
    expect(hasSequence(args, ["--proc", "/proc"])).toBe(true);
    expect(hasSequence(args, ["--dev", "/dev"])).toBe(true);
    expect(hasSequence(args, ["--tmpfs", "/sys"])).toBe(true);
    expect(hasSequence(args, ["--tmpfs", "/tmp"])).toBe(true);
    expect(hasSequence(args, ["--tmpfs", "/run"])).toBe(true);
    expect(hasSequence(args, ["--cap-drop", "ALL"])).toBe(true);
  });

  it("describes the private sysfs mount without claiming immutable permissions", () => {
    expect(describeBubblewrapMounts("/home/person/project")).toContainEqual({
      target: "/sys",
      access: "private",
      content: "empty private filesystem",
    });
  });

  it("shares only the network namespace in host mode", () => {
    const args = buildBubblewrapArguments("/home/person/project", ["/bin/true"], "host");

    expect(args).toContain("--unshare-all");
    expect(args).toContain("--share-net");
    expect(args).toContain("--unshare-user");
  });

  it("constructs a fixed environment without ambient credentials", () => {
    const environment = safeSandboxEnvironment();
    expect(environment.HOME).toBe("/run/pi-sandbox/home");
    expect(environment.PATH).toBeTruthy();
    expect(environment).not.toHaveProperty("SSH_AUTH_SOCK");
    expect(environment).not.toHaveProperty("AWS_ACCESS_KEY_ID");
  });

  it("adds validated custom variables after the fixed environment", () => {
    const args = buildBubblewrapArguments("/home/person/project", ["/bin/true"], "none", {
      Z_LAST: "z",
      CUSTOM_VALUE: "custom",
    });

    const homeIndex = sequenceIndex(args, ["--setenv", "HOME", "/run/pi-sandbox/home"]);
    const customIndex = sequenceIndex(args, ["--setenv", "CUSTOM_VALUE", "custom"]);
    const lastIndex = sequenceIndex(args, ["--setenv", "Z_LAST", "z"]);
    expect(homeIndex).toBeGreaterThanOrEqual(0);
    expect(customIndex).toBeGreaterThan(homeIndex);
    expect(lastIndex).toBeGreaterThan(customIndex);
  });

  it.each([
    { environment: { HOME: "/host/home" }, label: "fixed name" },
    { environment: { NODE_OPTIONS: "--require=payload" }, label: "runtime injection name" },
    { environment: { PI_SANDBOX_INTERNAL_TOKEN: "secret" }, label: "reserved prefix" },
    { environment: { "BAD-NAME": "value" }, label: "invalid name" },
    { environment: { VALID_NAME: "nul\0value" }, label: "NUL value" },
  ])("rejects a custom environment with a $label", ({ environment }) => {
    expect(() =>
      buildBubblewrapArguments("/home/person/project", ["/bin/true"], "none", environment),
    ).toThrow("sandbox_environment_invalid");
  });

  it.each([
    "/",
    "relative/path",
    "/proc",
    "/proc/project",
    "/sys/project",
    "/dev/shm/project",
    "/run/project",
  ])("rejects an unsafe launch directory: %s", (cwd) => {
    expect(() => assertSandboxCwd(cwd)).toThrow();
  });

  it("requires a direct absolute executable", () => {
    expect(() => buildBubblewrapArguments("/home/person/project", ["bash"])).toThrow(
      "sandbox_executable_not_absolute",
    );
  });

  it("rejects an invalid runtime network mode", () => {
    expect(() =>
      buildBubblewrapArguments("/home/person/project", ["/bin/true"], "filtered" as "none"),
    ).toThrow("sandbox_network_mode_invalid");
  });
});

function hasSequence(haystack: readonly string[], needle: readonly string[]): boolean {
  return haystack.some((_, index) =>
    needle.every((value, offset) => haystack[index + offset] === value),
  );
}

function sequenceIndex(haystack: readonly string[], needle: readonly string[]): number {
  return haystack.findIndex((_, index) =>
    needle.every((value, offset) => haystack[index + offset] === value),
  );
}
