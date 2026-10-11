/** Shared by runtime verification and Node 24+ release tooling. */
export const SMOLVM_VERSION = "1.26.1";
export const SMOLVM_SOURCE_COMMIT = "093852e8f527ce7db5f96195b909de15fef82251";
export const SMOLVM_RELEASE_SHA256 =
  "bcae519f7dad3cead2deaa0362a42a1ad7bffce73ea7a28161dea6822c559654";

/** Explicit build-target selection; the existing constant remains the Linux pin. */
export function smolvmReleaseForPlatform(platform: string, architecture: string) {
  if (platform === "linux" && architecture === "x64")
    return {
      platform: "linux/amd64",
      guestPlatform: "linux/amd64",
      sha256: SMOLVM_RELEASE_SHA256,
    } as const;
  if (platform === "darwin" && architecture === "arm64")
    return {
      platform: "darwin/arm64",
      guestPlatform: "linux/arm64",
      sha256: "3aee6c92aa0552754159494c2f073d5f99cf1c2a12ecc022a08976bd8a1fc5bb",
    } as const;
  throw new Error("smolvm_unsupported_platform");
}
