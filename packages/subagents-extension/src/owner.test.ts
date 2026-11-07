import * as fs from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { previousOwnerIsDead, probeProcess, processIdentity } from "./owner.js";

vi.mock("node:fs", { spy: true });
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(fs.readFileSync).mockReset();
});

describe("subagent process ownership", () => {
  it("matches a live process instance and distinguishes a reused PID or reboot", () => {
    const identity = processIdentity(process.pid);
    expect(previousOwnerIsDead(process.pid, identity)).toBe(false);
    expect(previousOwnerIsDead(process.pid, { ...identity, start: "different-start" })).toBe(true);
    expect(previousOwnerIsDead(process.pid, { ...identity, boot: "different-boot" })).toBe(true);
  });

  it("cannot displace an owner on EPERM and an unavailable process identity", () => {
    const identity = processIdentity(process.pid);
    vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("denied"), { code: "EPERM" });
    });
    vi.mocked(fs.readFileSync).mockImplementation(() => {
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
