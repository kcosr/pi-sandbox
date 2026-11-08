/** Trusted scratch imports are application capabilities, never model tools. */
export const IMPORT_LIMITS = Object.freeze({
  chunkBytes: 256 * 1024,
  maximumBytes: 512 * 1_048_576,
  maximumPathBytes: 4096,
  maximumDepth: 32,
  /** Bounds held import descriptors; does not limit ordinary command execution. */
  maximumSessions: 16,
});

export interface SandboxImportDirectory {
  /** Descriptor-anchored path usable only by commands inside the sandbox. */
  readonly path: string;
  /** User-facing path under the sandbox HOME. */
  readonly displayPath: string;
}

export interface SandboxImportSession {
  writeChunk(bytes: Uint8Array): Promise<void>;
  /** Seal the input and return a sandbox-local path retained until close(). */
  finish(): Promise<string>;
  /** Reserve one absent directory below HOME, creating missing parent directories. */
  reserveDirectory(relativePath: string): Promise<SandboxImportDirectory>;
  /** Reject if the reserved directory's visible path no longer names its inode. */
  verifyDirectory(): Promise<void>;
  /** Release temporary input and descriptors; never delete the reserved directory.
   * The owner must await commands using the returned paths before closing, including
   * after cancellation. Aborting the opening signal does not recycle these FDs. */
  close(): Promise<void>;
}

export interface SandboxImportTarget {
  open(signal?: AbortSignal): Promise<SandboxImportSession>;
}

export class SandboxImportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SandboxImportError";
  }
}

export function assertImportPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > IMPORT_LIMITS.maximumPathBytes ||
    value.includes("\0") ||
    Buffer.from(value).toString("utf8") !== value ||
    value.split("/").length > IMPORT_LIMITS.maximumDepth ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new SandboxImportError("import_invalid_path");
}
