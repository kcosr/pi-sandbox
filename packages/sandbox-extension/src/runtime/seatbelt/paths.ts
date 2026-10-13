import { realpath, stat } from "node:fs/promises";
import { posix } from "node:path";

declare const canonicalDirectory: unique symbol;

/** Existing directory resolved by realpath at validation time, not an inode lease. */
export type CanonicalSeatbeltDirectory = string & {
  readonly [canonicalDirectory]: true;
};

export function assertSeatbeltPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    posix.normalize(value) !== value ||
    (value !== "/" && value.endsWith("/")) ||
    Buffer.byteLength(value) > 4096 ||
    Buffer.from(value, "utf8").toString("utf8") !== value ||
    /\p{Cc}/u.test(value)
  ) {
    throw new Error("seatbelt_path_invalid");
  }
}

/**
 * Host-side validation only. In particular /tmp, /var and Homebrew aliases must
 * not be handed verbatim to SBPL. The executor revalidates at admission:
 * realpath/stat do not prevent subsequent replacement or alternate mount aliases.
 */
export async function canonicalizeSeatbeltDirectory(
  value: string,
): Promise<CanonicalSeatbeltDirectory> {
  assertSeatbeltPath(value);
  const resolved = await realpath(value);
  assertSeatbeltPath(resolved);
  if (!(await stat(resolved)).isDirectory()) throw new Error("seatbelt_path_not_directory");
  return resolved as CanonicalSeatbeltDirectory;
}

export function isSeatbeltPathWithin(root: string, candidate: string): boolean {
  return root === "/" || candidate === root || candidate.startsWith(`${root}/`);
}
