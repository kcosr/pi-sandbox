export const EXPORT_LIMITS = Object.freeze({
  entries: 100_000,
  depth: 64,
  bytes: 4 * 1024 ** 3,
  chunkBytes: 256 * 1024,
  inventoryBytes: 32 * 1024 ** 2,
  replacements: 1_000,
});

export function checkCancelled(signal?: AbortSignal): void {
  signal?.throwIfAborted();
}

export function exportError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  let text = "";
  let bytes = 0;
  for (const character of message) {
    bytes += Buffer.byteLength(character);
    if (bytes > 1024) break;
    text += character;
  }
  return text;
}

/** Render untrusted filenames as visible data rather than terminal instructions. */
export function displayPath(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replace(
      /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu,
      (character) => `\\u{${character.codePointAt(0)!.toString(16)}}`,
    );
}
