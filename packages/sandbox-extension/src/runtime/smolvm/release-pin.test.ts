import { describe, expect, it } from "vitest";
import { SMOLVM_RELEASE_SHA256, smolvmReleaseForPlatform } from "./release-pin.js";
describe("explicit smolvm build platform", () => {
  it("selects the qualified Linux and independent Darwin arm64 archives", () => {
    expect(smolvmReleaseForPlatform("linux", "x64").sha256).toBe(SMOLVM_RELEASE_SHA256);
    expect(smolvmReleaseForPlatform("darwin", "arm64")).toEqual({
      platform: "darwin/arm64",
      guestPlatform: "linux/arm64",
      sha256: "fc14c9879bb34e62c4b0d3182594f0f87d8a96453ce0741b43f546cc56fa2bd5",
    });
    expect(smolvmReleaseForPlatform("darwin", "arm64").sha256).not.toBe(SMOLVM_RELEASE_SHA256);
    expect(() => smolvmReleaseForPlatform("darwin", "x64")).toThrow();
    expect(() => smolvmReleaseForPlatform("linux", "arm64")).toThrow();
  });
});
