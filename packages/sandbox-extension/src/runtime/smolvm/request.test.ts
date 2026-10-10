import { describe, expect, it } from "vitest";
import { resolveSmolvmLimits, smolvmEnvironment, smolvmRequest } from "./request.js";

describe("smolvm request admission", () => {
  it("preserves large packed input capacity while accepting bounded OCI contexts", () => {
    const limits = resolveSmolvmLimits();
    expect(limits.maximumInputBytes).toBe(64 * 1_048_576);
    const input = Buffer.from("value");
    const parsed = smolvmRequest(
      { argv: ["/bin/echo", "arg"], cwd: "/tmp", environment: { TEST: "v" }, stdin: input },
      limits,
      "/workspace",
    );
    input.fill(0);
    expect(parsed.stdin.toString()).toBe("value");
    expect(parsed.cwd).toBe("/tmp");
    expect(parsed.environment).toEqual({ TEST: "v" });
  });
  it.each([
    "HOME",
    "PATH",
    "NODE_OPTIONS",
    "BASH_ENV",
    "SMOLVM_BOOT_BINARY",
    "HTTP_PROXY",
    "SSH_AUTH_SOCK",
  ])("rejects authority through %s", (key) => {
    expect(() => smolvmEnvironment({ [key]: "override" })).toThrow();
  });
  it("rejects unknown fields and oversized OCI input before launch", () => {
    expect(() => resolveSmolvmLimits({ unknown: 2 } as never)).toThrow();
    expect(() =>
      smolvmRequest({ argv: ["/bin/true"], extra: true } as never, resolveSmolvmLimits(), "/"),
    ).toThrow();
    expect(() =>
      smolvmRequest(
        { argv: ["/bin/true"], stdin: "abcd" },
        resolveSmolvmLimits({ maximumInputBytes: 3 }),
        "/",
      ),
    ).toThrowError(expect.objectContaining({ code: "sandbox_input_too_large" }));
  });
});
