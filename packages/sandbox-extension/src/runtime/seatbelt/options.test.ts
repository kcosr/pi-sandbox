import { describe, expect, it } from "vitest";
import {
  resolveSeatbeltLimits,
  seatbeltRequest,
  validateSeatbeltOptions,
  type CreateSeatbeltExecutorOptions,
} from "./options.js";

describe("Seatbelt admission validation", () => {
  it("validates future policy paths without filesystem or platform prerequisites", () => {
    expect(() =>
      validateSeatbeltOptions({
        cwd: "/work/future",
        deniedPaths: ["/work", "/work/future/private"],
        cwdWritable: false,
      }),
    ).not.toThrow();
  });
  it.each([
    { networkMode: "local" },
    { networkMode: null },
    { cwdWritable: null },
    { deniedPaths: null },
    { hiddenPaths: [] },
    { sandboxExecPath: "/usr/bin/sandbox-exec" },
    { profile: "(allow default)" },
    { processLifetime: "sandbox" },
    { hostCacheDirectory: "/cache" },
    { deniedPaths: ["/work/project"] },
    { deniedPaths: ["/tmp/secret"] },
    { environment: { HOME: "/work" } },
    { environment: { DYLD_INSERT_LIBRARIES: "/work/x" } },
    { environment: { BASH_ENV: "/work/x" } },
    { environment: { SSH_AUTH_SOCK: "/work/x" } },
    { limits: { defaultTimeoutMs: 20, maximumTimeoutMs: 10 } },
    { limits: { maximumTimeoutMs: 2 ** 32 } },
  ])("rejects unsafe or unsupported policy %j", (change) => {
    expect(() =>
      validateSeatbeltOptions({ cwd: "/work/project", ...change } as CreateSeatbeltExecutorOptions),
    ).toThrow();
  });
  it("snapshots binary input, argv and environment before queue admission", () => {
    const input = Uint8Array.from([0, 255, 7]);
    const argv: [string, ...string[]] = ["/bin/cat", "original"];
    const environment = { CUSTOM: "original" };
    const request = seatbeltRequest(
      { argv, stdin: input, environment },
      resolveSeatbeltLimits(),
      "/work/project",
    );
    input.fill(1);
    argv[1] = "changed";
    environment.CUSTOM = "changed";
    expect(request.stdin).toEqual(Buffer.from([0, 255, 7]));
    expect(request.argv[1]).toBe("original");
    expect(request.environment.CUSTOM).toBe("original");
  });
  it("bounds input before copying and limits request contexts", () => {
    expect(() =>
      seatbeltRequest(
        { argv: ["/bin/cat"], stdin: Buffer.alloc(3) },
        resolveSeatbeltLimits({ maximumInputBytes: 2 }),
        "/work/project",
      ),
    ).toThrow("sandbox_input_too_large");
    expect(() =>
      seatbeltRequest(
        { argv: ["/bin/cat"], cwd: "/outside" },
        resolveSeatbeltLimits(),
        "/work/project",
      ),
    ).toThrow("sandbox_invalid_request");
  });
});
