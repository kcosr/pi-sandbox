export const MAXIMUM_ADMINISTRATIVE_PATH_BYTES = 4096;

export const PRIVATE_SANDBOX_SYSTEM_PATHS = Object.freeze(["/proc", "/sys", "/dev", "/run"]);

/** Host-independent exclusions for an otherwise normalized absolute hidden path. */
export function isReservedHiddenDirectoryPath(value: string): boolean {
  return (
    value === "/" ||
    value === "/tmp" ||
    PRIVATE_SANDBOX_SYSTEM_PATHS.some(
      (reserved) => value === reserved || value.startsWith(`${reserved}/`),
    )
  );
}

export function isNormalizedAbsoluteFilePath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !value.startsWith("/") ||
    value.length <= 1 ||
    Buffer.byteLength(value) > MAXIMUM_ADMINISTRATIVE_PATH_BYTES ||
    [...value].some((character) => /\p{Cc}/u.test(character))
  ) {
    return false;
  }

  return value
    .slice(1)
    .split("/")
    .every((component) => component.length > 0 && component !== "." && component !== "..");
}
