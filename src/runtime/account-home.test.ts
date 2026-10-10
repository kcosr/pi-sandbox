import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readAccountIdentity } from "./account-home.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const originalGeteuid = Object.getOwnPropertyDescriptor(process, "geteuid")!;
const execute = vi.mocked(execFileSync);
const errorMessage = "Unable to resolve the invoking account's identity from the operating system";

function platform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value });
}

function output(value: string): void {
  execute.mockReturnValue(Buffer.from(value));
}

function macAccount(home = "/Users/alice"): string {
  return `name: alice\npassword: ********\nuid: 1001\ngid: 20\ndir: ${home}\nshell: /bin/zsh\ngecos: Alice Example\n\n`;
}

beforeEach(() => {
  platform("linux");
  Object.defineProperty(process, "geteuid", { value: () => 1001 });
  execute.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  Object.defineProperty(process, "geteuid", originalGeteuid);
  vi.unstubAllEnvs();
});

describe("account home lookup", () => {
  it("uses the effective UID with fixed executable, clean environment, and bounded I/O", () => {
    vi.stubEnv("HOME", "/attacker/home");
    vi.stubEnv("USER", "attacker");
    vi.stubEnv("LOGNAME", "attacker");
    vi.stubEnv("SUDO_USER", "attacker");
    vi.stubEnv("PATH", "/attacker/bin");
    vi.stubEnv("LD_PRELOAD", "/attacker/inject.so");
    vi.stubEnv("DYLD_INSERT_LIBRARIES", "/attacker/inject.dylib");
    vi.stubEnv("MODEL_TOKEN", "secret");
    output("alice:x:1001:20:Alice Example:/home/alice:/bin/bash\n");

    expect(readAccountIdentity()).toEqual({
      username: "alice",
      uid: 1001,
      homeDirectory: "/home/alice",
    });
    expect(execute).toHaveBeenCalledExactlyOnceWith("/usr/bin/getent", ["--", "passwd", "1001"], {
      cwd: "/",
      env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
      killSignal: "SIGKILL",
      maxBuffer: 65_536,
    });
  });

  it("queries the macOS account database by UID and preserves spaces and colons in home paths", () => {
    platform("darwin");
    output(macAccount("/Users/Alice Example:Projects"));
    expect(readAccountIdentity().homeDirectory).toBe("/Users/Alice Example:Projects");
    expect(execute).toHaveBeenCalledWith(
      "/usr/bin/dscacheutil",
      ["-q", "user", "-a", "uid", "1001"],
      expect.objectContaining({ env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" } }),
    );
  });

  it.each(["/", "/home/álîce", "/srv/accounts/alice"])(
    "accepts the OS-provided normalized home %s",
    (home) => {
      output(`alice:x:1001:20::${home}:/bin/sh`);
      expect(readAccountIdentity().homeDirectory).toBe(home);
    },
  );

  it.each([
    "",
    "alice:x:1002:20::/home/alice:/bin/sh\n",
    "alice:x:1001.0:20::/home/alice:/bin/sh\n",
    "alice:x:1001:invalid::/home/alice:/bin/sh\n",
    "alice:x:1001:4294967296::/home/alice:/bin/sh\n",
    "alice:x:1001:20:/home/alice:/bin/sh\n",
    "123:x:1001:20::/home/alice:/bin/sh\n",
    "alice:x:1001:20::/home/alice:/bin/sh\nbob:x:1001:20::/home/bob:/bin/sh\n",
    "alice:x:1001:20::/home/alice:/bin/sh\n\n",
    "alice:x:1001:20::/home/alice:/bin/sh\r\n",
  ])("rejects missing, malformed, or ambiguous Linux account records", (value) => {
    output(value);
    expect(readAccountIdentity).toThrow(errorMessage);
  });

  it.each([
    "",
    macAccount().replace("uid: 1001", "uid: 1002"),
    macAccount().replace("uid: 1001\n", ""),
    macAccount().replace("dir: /Users/alice\n", ""),
    macAccount().replace("gid: 20", "gid: unknown"),
    macAccount().replace("dir: /Users/alice", "dir: /Users/alice\ndir: /Users/bob"),
    macAccount() + macAccount("/Users/bob"),
    macAccount().replace("name: alice", "unknown: alice"),
    macAccount().replace("name: alice", "name alice"),
    macAccount().replace("name: alice", "name: two names"),
  ])("rejects missing, malformed, or ambiguous macOS account records", (value) => {
    platform("darwin");
    output(value);
    expect(readAccountIdentity).toThrow(errorMessage);
  });

  it.each([
    "",
    "relative",
    "~/home",
    "/home/../alice",
    "/home//alice",
    "/home/alice/",
    "/home/a\0b",
  ])("rejects invalid home paths on either platform", (home) => {
    output(`alice:x:1001:20::${home}:/bin/sh\n`);
    expect(readAccountIdentity).toThrow(errorMessage);
    platform("darwin");
    output(macAccount(home));
    expect(readAccountIdentity).toThrow(errorMessage);
  });

  it("rejects invalid UTF-8 and oversized output", () => {
    execute.mockReturnValue(Buffer.from([0xc0, 0xaf]));
    expect(readAccountIdentity).toThrow(errorMessage);
    execute.mockReturnValue(Buffer.alloc(65_537, "x"));
    expect(readAccountIdentity).toThrow(errorMessage);
  });

  it.each(["ENOENT", "ETIMEDOUT", "ENOBUFS", "EACCES"])(
    "fails closed on %s without leaking command output or falling back to HOME",
    (code) => {
      vi.stubEnv("HOME", "/fallback/home");
      execute.mockImplementation(() => {
        throw Object.assign(new Error("sensitive account metadata"), {
          code,
          stdout: "sensitive stdout",
          stderr: "sensitive stderr",
        });
      });
      try {
        readAccountIdentity();
        expect.fail("lookup should fail");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(errorMessage);
        expect((error as Error).cause).toBeUndefined();
      }
    },
  );

  it("does not start a command without a supported platform and effective UID", () => {
    platform("win32");
    expect(readAccountIdentity).toThrow(errorMessage);
    platform("linux");
    Object.defineProperty(process, "geteuid", { value: undefined });
    expect(readAccountIdentity).toThrow(errorMessage);
    Object.defineProperty(process, "geteuid", { value: () => -1 });
    expect(readAccountIdentity).toThrow(errorMessage);
    expect(execute).not.toHaveBeenCalled();
  });
});
