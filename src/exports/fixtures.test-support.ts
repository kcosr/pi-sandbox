import { Buffer } from "node:buffer";
import type { DialogTheme } from "./dialog.js";

export const dialogTheme: DialogTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
  inverse: (text) => text,
};
import type {
  SandboxExportEntry,
  SandboxExportReader,
  SandboxExportSource,
} from "../../packages/sandbox-extension/src/runtime/export/contracts.js";

export function entry(
  path: string,
  options: {
    readonly rootId?: "home" | "tmp";
    readonly kind?: SandboxExportEntry["kind"];
    readonly size?: number;
  } = {},
): SandboxExportEntry {
  const size = options.size ?? 3;
  return {
    rootId: options.rootId ?? "home",
    path,
    name: path.split("/").at(-1)!,
    kind: options.kind ?? "file",
    size,
    identity: { dev: "1", ino: "2", size: String(size), mtimeNs: "3", ctimeNs: "4" },
  };
}

export function readerFixture(
  entries: readonly SandboxExportEntry[],
  data: Readonly<Record<string, string>> = {},
): {
  reader: SandboxExportReader;
  source: SandboxExportSource;
} {
  let chunks: Uint8Array[] = [];
  const reader: SandboxExportReader = {
    roots: [
      { id: "home", label: "Home" },
      { id: "tmp", label: "Temporary" },
    ],
    list(rootId, path) {
      return Promise.resolve({
        entries: entries.filter(
          (value) =>
            value.rootId === rootId && value.path.split("/").slice(0, -1).join("/") === path,
        ),
      });
    },
    openFile(value) {
      chunks = [Buffer.from(data[`${value.rootId}/${value.path}`] ?? "abc")];
      return Promise.resolve();
    },
    readChunk() {
      return Promise.resolve(chunks.shift() ?? new Uint8Array());
    },
    closeFile() {
      chunks = [];
      return Promise.resolve();
    },
    close() {
      return Promise.resolve();
    },
  };
  return {
    reader,
    source: {
      writableHostPaths: [],
      open() {
        return Promise.resolve(reader);
      },
    },
  };
}
