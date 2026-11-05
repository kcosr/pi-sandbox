/** Private-file reads are a host/UI capability, never part of SandboxExecutor. */
export const EXPORT_LIMITS = Object.freeze({
  maximumEntries: 100_000,
  maximumDepth: 64,
  maximumPathBytes: 4096,
  maximumInventoryBytes: 32 * 1_048_576,
  maximumPageBytes: 512 * 1024,
  maximumPageEntries: 128,
  chunkBytes: 256 * 1024,
  maximumBytes: 4 * 1024 * 1_048_576,
});

export type SandboxExportRootId = "home" | "tmp";

export interface SandboxExportRoot {
  readonly id: SandboxExportRootId;
  readonly label: string;
}

export interface SandboxExportIdentity {
  readonly dev: string;
  readonly ino: string;
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
}

export interface SandboxExportEntry {
  readonly rootId: SandboxExportRootId;
  /** Root-relative UTF-8 path. The empty path identifies the root directory. */
  readonly path: string;
  readonly name: string;
  readonly kind: "file" | "directory" | "unsupported";
  readonly size: number;
  readonly identity: SandboxExportIdentity;
  readonly problem?: string;
}

export interface SandboxExportPage {
  readonly entries: readonly SandboxExportEntry[];
  readonly nextCursor?: string;
}

export interface SandboxExportReader {
  readonly roots: readonly SandboxExportRoot[];
  list(rootId: SandboxExportRootId, path: string, cursor?: string): Promise<SandboxExportPage>;
  openFile(entry: SandboxExportEntry): Promise<void>;
  /** One bounded pull. Empty bytes mean metadata-checked end of file. */
  readChunk(): Promise<Uint8Array>;
  closeFile(): Promise<void>;
  close(): Promise<void>;
}

export interface SandboxExportSource {
  /** Actual writable host grants; namespace-private paths are not host grants. */
  readonly writableHostPaths: readonly string[];
  /** One reader may be open at a time. Closing it releases all export resources. */
  open(signal?: AbortSignal): Promise<SandboxExportReader>;
}

export interface RegisteredExportRoot {
  readonly id: SandboxExportRootId;
  readonly path: string;
  readonly identity?: SandboxExportIdentity;
  /** Root-relative subtrees which are host overlays rather than private data. */
  readonly excludedPaths?: readonly string[];
}

export class SandboxExportError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "SandboxExportError";
  }
}

export function assertExportPath(value: unknown, allowRoot = true): asserts value is string {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > EXPORT_LIMITS.maximumPathBytes ||
    value.includes("\0") ||
    Buffer.from(value).toString("utf8") !== value ||
    (!allowRoot && value.length === 0) ||
    (value.length !== 0 &&
      (value.split("/").length > EXPORT_LIMITS.maximumDepth ||
        value
          .split("/")
          .some((component) => !component || component === "." || component === "..")))
  )
    throw new SandboxExportError("export_invalid_path");
}

export function sameExportIdentity(a: SandboxExportIdentity, b: SandboxExportIdentity): boolean {
  return (
    a.dev === b.dev &&
    a.ino === b.ino &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}
