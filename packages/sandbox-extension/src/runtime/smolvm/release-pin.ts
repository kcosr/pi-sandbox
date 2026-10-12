/** Reviewed two-fix fork host with official 1.27.0 libraries and guest.
 * Source: https://github.com/kcosr/smolvm/tree/integration-prepared-vm-tree-1.27
 * These digests identify qualified fork archives, not upstream releases. */
export const SMOLVM_VERSION = "1.27.0";
export const SMOLVM_SOURCE_COMMIT = "cb9d4879a31d50341d2cc2db8e9723eec1ecbf5b";
export const SMOLVM_RELEASE_SHA256 =
  "4f260be0500ad5a12c8d766347f56de6583e5fb1d4d4b667fc773529a6b73ed0";

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
      sha256: "fc14c9879bb34e62c4b0d3182594f0f87d8a96453ce0741b43f546cc56fa2bd5",
    } as const;
  throw new Error("smolvm_unsupported_platform");
}
