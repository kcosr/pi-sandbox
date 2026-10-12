import { describe, expect, it } from "vitest";
import { SMOLVM_RELEASE_SHA256, smolvmReleaseForPlatform } from "./release-pin.js";
describe("explicit smolvm build platform", () => {
  it("preserves the Linux pin and selects the independent Darwin arm64 release", () => {
    expect(smolvmReleaseForPlatform("linux", "x64").sha256).toBe(SMOLVM_RELEASE_SHA256);
    expect(smolvmReleaseForPlatform("darwin", "arm64")).toEqual({
      platform: "darwin/arm64",
      guestPlatform: "linux/arm64",
      sha256: "a9d070ce98979690a75db67f3d05dbaaf85e92af8f046943031cd0cc1099d7ab",
    });
    expect(smolvmReleaseForPlatform("darwin", "arm64").sha256).not.toBe(SMOLVM_RELEASE_SHA256);
    expect(() => smolvmReleaseForPlatform("darwin", "x64")).toThrow();
    expect(() => smolvmReleaseForPlatform("linux", "arm64")).toThrow();
  });
});
