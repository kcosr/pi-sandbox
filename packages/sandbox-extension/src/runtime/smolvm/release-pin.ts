/** Reviewed two-fix fork host with official 1.26.1 libraries and guest.
 * Source: https://github.com/kcosr/smolvm/tree/integration-prepared-vm-tree
 * These digests identify qualified fork archives, not upstream releases. */
export const SMOLVM_VERSION = "1.26.1";
export const SMOLVM_SOURCE_COMMIT = "91fc328186bc7b8c38b313139b44ca7ffc4a2b52";
export const SMOLVM_RELEASE_SHA256 =
  "c7896652d08e24010e576c48a108d8f8cf1bcc7dce1968185e589b749218f1b1";

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
      sha256: "a9d070ce98979690a75db67f3d05dbaaf85e92af8f046943031cd0cc1099d7ab",
    } as const;
  throw new Error("smolvm_unsupported_platform");
}
