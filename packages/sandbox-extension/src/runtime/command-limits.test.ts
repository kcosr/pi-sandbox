import { describe, expect, it } from "vitest";
import {
  resolveCommandTimeout,
  resolveSandboxLimits,
  validateCommandRequest,
} from "./command-limits.js";

describe("optional command timeouts", () => {
  it("has no implicit timer, accepts long and fractional durations, and applies only a configured ceiling", () => {
    expect(resolveCommandTimeout()).toBeUndefined();
    expect(resolveCommandTimeout(3_600_000)).toBe(3_600_000);
    expect(resolveCommandTimeout(0.1)).toBe(0.1);
    expect(resolveCommandTimeout(undefined, 3500)).toBe(3500);
    expect(resolveCommandTimeout(100, 3500)).toBe(100);
    expect(() => resolveCommandTimeout(3501, 3500)).toThrow("sandbox_invalid_request");
    expect(
      validateCommandRequest({ argv: ["/bin/sh"] }, resolveSandboxLimits()).timeoutMs,
    ).toBeUndefined();
  });
  it.each([0, -1, NaN, Infinity, 2_147_483_648])("rejects invalid timer %s", (value) => {
    expect(() => resolveCommandTimeout(value)).toThrow();
    expect(() => resolveSandboxLimits({ maximumTimeoutMs: value })).toThrow();
  });
  it("rejects the removed default timeout option rather than silently ignoring it", () => {
    expect(() => resolveSandboxLimits({ defaultTimeoutMs: 2000 } as never)).toThrow();
  });
});
