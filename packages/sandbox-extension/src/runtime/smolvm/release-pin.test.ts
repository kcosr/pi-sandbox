import { describe, expect, it } from "vitest";
import { SMOLVM_RELEASE_SHA256, smolvmReleaseForPlatform } from "./release-pin.js";
describe("explicit smolvm build platform", () => {
  it("preserves the Linux pin and selects the independent Darwin arm64 release", () => {
    expect(smolvmReleaseForPlatform("linux", "x64").sha256).toBe(SMOLVM_RELEASE_SHA256);
    expect(smolvmReleaseForPlatform("darwin", "arm64")).toEqual({
      platform: "darwin/arm64",
      guestPlatform: "linux/arm64",
      sha256: "3aee6c92aa0552754159494c2f073d5f99cf1c2a12ecc022a08976bd8a1fc5bb",
    });
    expect(smolvmReleaseForPlatform("darwin", "arm64").sha256).not.toBe(SMOLVM_RELEASE_SHA256);
    expect(() => smolvmReleaseForPlatform("darwin", "x64")).toThrow();
    expect(() => smolvmReleaseForPlatform("linux", "arm64")).toThrow();
  });
});
