import * as fs from "node:fs";
import * as childProcess from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isProcessIdentity, previousOwnerIsDead, probeProcess, processIdentity } from "./owner.js";

vi.mock("node:fs", { spy: true });
vi.mock("node:child_process", { spy: true });
const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  Object.defineProperty(process, "platform", platform);
  vi.mocked(fs.readFileSync).mockReset();
  vi.mocked(childProcess.execFileSync).mockReset();
});

describe("subagent process ownership", () => {
  it("matches a live process instance and distinguishes a reused PID or reboot", () => {
    const identity = processIdentity(process.pid);
    expect(previousOwnerIsDead(process.pid, identity)).toBe(false);
    expect(previousOwnerIsDead(process.pid, { ...identity, start: "different-start" })).toBe(true);
    if (identity.platform === "linux")
      expect(previousOwnerIsDead(process.pid, { ...identity, boot: "different-boot" })).toBe(true);
  });

  it.each(["darwin", "win32"] as const)(
    "%s uses the absolute start and cannot displace a live owner after a boot-clock change",
    (platform) => {
      Object.defineProperty(process, "platform", { value: platform });
      vi.stubEnv("SystemRoot", "C:\\Windows");
      const start = platform === "darwin" ? "Sat Nov  7 13:00:00 2026" : "639297972000000000";
      vi.mocked(childProcess.execFileSync).mockImplementation((_program, args) =>
        Array.isArray(args) && args.includes("stat=") ? "S" : start,
      );
      const original = { platform, start, boot: "before-clock-step" };
      const afterClockStep = { ...original, boot: "after-clock-step" };
      expect(probeProcess(process.pid)).toEqual({ state: "live", identity: { platform, start } });
      expect(previousOwnerIsDead(process.pid, original)).toBe(false);
      expect(previousOwnerIsDead(process.pid, afterClockStep)).toBe(false);
      expect(previousOwnerIsDead(process.pid, { platform, start: "previous-process" })).toBe(true);
      expect(isProcessIdentity({ platform, start })).toBe(true);
      expect(isProcessIdentity(original)).toBe(false);
      expect(JSON.stringify(vi.mocked(childProcess.execFileSync).mock.calls)).not.toMatch(
        /sysctl|boottime|Get-CimInstance|LastBootUpTime/,
      );
    },
  );

  it("caches the current process identity without repeating probes", async () => {
    vi.resetModules();
    const fresh = await import("./owner.js");
    const first = fresh.processIdentity(process.pid);
    const calls = () =>
      vi.mocked(fs.readFileSync).mock.calls.length +
      vi.mocked(childProcess.execFileSync).mock.calls.length;
    const initialCalls = calls();
    expect(initialCalls).toBeGreaterThan(0);
    for (let index = 0; index < 20; index++) expect(fresh.processIdentity(process.pid)).toBe(first);
    expect(calls()).toBe(initialCalls);
  });

  it("cannot displace an owner on EPERM and an unavailable process identity", () => {
    const identity = processIdentity(process.pid);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    vi.mocked(fs.readFileSync).mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    vi.mocked(childProcess.execFileSync).mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    });
    expect(probeProcess(process.pid)).toEqual({ state: "unknown" });
    expect(previousOwnerIsDead(process.pid, identity)).toBe(false);
  });

  it("recognizes an absent process without needing to read its identity", () => {
    const identity = processIdentity(process.pid);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("gone"), { code: "ESRCH" });
    });
    expect(previousOwnerIsDead(process.pid, identity)).toBe(true);
  });
});
