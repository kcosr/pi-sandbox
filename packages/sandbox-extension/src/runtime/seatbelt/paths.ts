import { lstat, realpath, stat } from "node:fs/promises";
import { posix } from "node:path";

declare const canonicalDirectory: unique symbol;
declare const canonicalPath: unique symbol;

/** Existing canonical regular file or directory, not an inode lease. */
export type CanonicalSeatbeltPath = string & { readonly [canonicalPath]: true };

/** Existing directory resolved by realpath at validation time, not an inode lease. */
export type CanonicalSeatbeltDirectory = CanonicalSeatbeltPath & {
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

/** Skip absent targets only; inspect existing ancestors so dangling links cannot look absent. */
export async function resolveSeatbeltDeniedPath(
  value: string,
): Promise<CanonicalSeatbeltPath | undefined> {
  assertSeatbeltPath(value);
  const parts = value.split("/").filter(Boolean);
  let current = "";
  for (const [index, part] of parts.entries()) {
    current += `/${part}`;
    const info = await lstat(current).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    });
    if (info === undefined) {
      const parent = posix.dirname(current);
      if ((await realpath(parent)) !== parent) throw new Error("sandbox_denied_path_not_canonical");
      return undefined;
    }
    if (info.isSymbolicLink()) throw new Error("sandbox_denied_path_not_canonical");
    if (index < parts.length - 1) {
      if (!info.isDirectory()) throw new Error("seatbelt_path_not_directory");
    } else if (!info.isDirectory() && !info.isFile()) {
      throw new Error("seatbelt_denied_path_type_invalid");
    }
  }
  if ((await realpath(value)) !== value) throw new Error("sandbox_denied_path_not_canonical");
  return value as CanonicalSeatbeltPath;
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
