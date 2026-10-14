import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createMachineIdResolver, readMachineId } from "./machine-id.js";

vi.mock("node:child_process", () => ({ execFileSync: vi.fn() }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, "platform")!;
const execute = vi.mocked(execFileSync);
const errorMessage = "Unable to resolve the machine ID from the operating system";
const machineId = "12345678-9ABC-5DEF-8123-456789ABCDEF";

function platform(value: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value });
}

function registry(value = machineId): string {
  return `+-o Platform  <class IOPlatformExpertDevice, id 0x1, registered>\n  {\n    "IOPlatformUUID" = "${value}"\n  }\n`;
}

function output(value: string): void {
  execute.mockReturnValue(Buffer.from(value));
}

beforeEach(() => {
  platform("darwin");
  execute.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, "platform", originalPlatform);
  vi.unstubAllEnvs();
});

describe("machine ID lookup", () => {
  it("uses fixed OS arguments and bounded I/O without ambient identity, search paths or credentials", () => {
    vi.stubEnv("HOME", "/untrusted/home");
    vi.stubEnv("USER", "untrusted");
    vi.stubEnv("HOSTNAME", "untrusted");
    vi.stubEnv("PATH", "/untrusted/bin");
    vi.stubEnv("DYLD_INSERT_LIBRARIES", "/untrusted/inject.dylib");
    vi.stubEnv("NODE_OPTIONS", "--require=/untrusted/inject.cjs");
    vi.stubEnv("PI_MACHINE_ID", "untrusted");
    vi.stubEnv("MODEL_TOKEN", "sensitive-token");
    output(registry());

    expect(readMachineId()).toBe(machineId);
    expect(execute).toHaveBeenCalledExactlyOnceWith(
      "/usr/sbin/ioreg",
      ["-rd1", "-c", "IOPlatformExpertDevice"],
      {
        cwd: "/",
        env: { PATH: "/usr/bin:/bin", LANG: "C", LC_ALL: "C" },
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5_000,
        killSignal: "SIGKILL",
        maxBuffer: 65_536,
      },
    );
    expect(process.env.PI_MACHINE_ID).toBe("untrusted");
  });

  it("normalizes the UUID without returning unrelated registry fields", () => {
    output(registry(machineId.toLowerCase()).replace("  }", '    "unrelated" = "private"\n  }'));
    expect(readMachineId()).toBe(machineId);
  });

  it.each([
    "",
    "no UUID\n",
    registry("00000000-0000-0000-0000-000000000000"),
    registry("not-a-uuid"),
    registry("12345678-9ABC-5DEF-8123-456789ABCDEG"),
    registry("12345678-9ABC-5DEF-8123-456789ABCDEF-extra"),
    registry(" 12345678-9ABC-5DEF-8123-456789ABCDEF"),
    registry().replace('"IOPlatformUUID" = ', '"IOPlatformUUID" : '),
    registry().replace('"IOPlatformUUID"', '"IOPlatformUUID" malformed'),
    registry().replace('"IOPlatformUUID" = "', '"IOPlatformUUID" = <'),
    registry().replace(`"${machineId}"`, `"${machineId}" trailing`),
    registry() + registry(),
    registry() + '"IOPlatformUUID" = "invalid"\n',
    registry() + '"extra" = "IOPlatformUUID"\n',
    registry() + "\0",
    registry().replaceAll("\n", "\r\n"),
  ])("rejects missing, malformed, ambiguous, or control-bearing output", (value) => {
    output(value);
    expect(readMachineId).toThrow(errorMessage);
  });

  it("rejects invalid UTF-8 and oversized output even if a UUID is present", () => {
    execute.mockReturnValue(Buffer.concat([Buffer.from(registry()), Buffer.from([0xc0, 0xaf])]));
    expect(readMachineId).toThrow(errorMessage);
    output(registry() + "x".repeat(65_537));
    expect(readMachineId).toThrow(errorMessage);
  });

  it.each(["ENOENT", "ETIMEDOUT", "ENOBUFS", "EACCES", "nonzero-exit"])(
    "fails closed on %s without returning raw command output or an ambient fallback",
    (code) => {
      vi.stubEnv("PI_MACHINE_ID", machineId);
      execute.mockImplementation(() => {
        throw Object.assign(new Error("sensitive registry metadata"), {
          code,
          stdout: "sensitive stdout",
          stderr: "sensitive stderr",
        });
      });
      try {
        readMachineId();
        expect.fail("lookup should fail");
      } catch (error) {
        expect(error).toBeInstanceOf(Error);
        expect((error as Error).message).toBe(errorMessage);
        expect((error as Error).cause).toBeUndefined();
      }
    },
  );

  it.each(["linux", "win32", "freebsd"] as const)(
    "does not launch or fall back to environment on %s",
    (value) => {
      platform(value);
      vi.stubEnv("PI_MACHINE_ID", machineId);
      expect(readMachineId).toThrow(errorMessage);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it("creates a lazy resolver that caches one successful lookup", () => {
    output(registry());
    const resolve = createMachineIdResolver();
    expect(execute).not.toHaveBeenCalled();
    expect(resolve()).toBe(machineId);
    output(registry("AAAAAAAA-BBBB-5CCC-8DDD-EEEEEEEEEEEE"));
    expect(resolve()).toBe(machineId);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("caches lookup failures rather than retrying the host command", () => {
    output("unavailable");
    const resolve = createMachineIdResolver();
    expect(resolve).toThrow(errorMessage);
    output(registry());
    expect(resolve).toThrow(errorMessage);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("remains lazy on unsupported platforms", () => {
    platform("linux");
    const resolve = createMachineIdResolver();
    expect(execute).not.toHaveBeenCalled();
    expect(resolve).toThrow(errorMessage);
    expect(execute).not.toHaveBeenCalled();
  });
});
