import { describe, expect, it } from "vitest";
import {
  BUBBLEWRAP_SECCOMP_FD,
  assertSandboxCwd,
  buildBubblewrapArguments,
  describeBubblewrapMounts,
  safeSandboxEnvironment,
} from "./bubblewrap-policy.js";

describe("Bubblewrap policy", () => {
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
