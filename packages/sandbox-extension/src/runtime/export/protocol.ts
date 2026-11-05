import {
  assertExportPath,
  EXPORT_LIMITS,
  type RegisteredExportRoot,
  type SandboxExportEntry,
  type SandboxExportIdentity,
  type SandboxExportPage,
  type SandboxExportRoot,
} from "./contracts.js";
import type { ExportFileService } from "./files.js";

export const INTERNAL_EXPORT_READER_ARGUMENT = "--pi-sandbox-internal-export-reader";

export type ExportOperation =
  | { readonly operation: "begin" }
  | {
      readonly operation: "list";
      readonly rootId: "home" | "tmp";
      readonly path: string;
      readonly cursor?: string;
    }
  | { readonly operation: "open"; readonly entry: SandboxExportEntry }
  | { readonly operation: "read" }
  | { readonly operation: "closeFile" }
  | { readonly operation: "end" };

export type ExportReply =
  | { readonly operation: "begin"; readonly roots: readonly SandboxExportRoot[] }
  | { readonly operation: "list"; readonly page: SandboxExportPage }
  | { readonly operation: "read"; readonly data: string }
  | { readonly operation: "open" | "closeFile" | "end" };

export interface ExportReaderConfiguration {
  readonly roots: readonly RegisteredExportRoot[];
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, names: readonly string[]): boolean {
  return (
    Object.keys(value).length === names.length && names.every((name) => Object.hasOwn(value, name))
  );
}
function validPath(value: unknown): value is string {
  try {
    assertExportPath(value);
    return true;
  } catch {
    return false;
  }
}

export function isExportIdentity(value: unknown): value is SandboxExportIdentity {
  return (
    record(value) &&
    keys(value, ["dev", "ino", "size", "mtimeNs", "ctimeNs"]) &&
    ["dev", "ino", "size", "mtimeNs", "ctimeNs"].every(
      (key) => typeof value[key] === "string" && /^-?\d{1,30}$/u.test(value[key]),
    )
  );
}

export function isExportEntry(value: unknown): value is SandboxExportEntry {
  return (
    record(value) &&
    keys(value, [
      "rootId",
      "path",
      "name",
      "kind",
      "size",
      "identity",
      ...(value.problem === undefined ? [] : ["problem"]),
    ]) &&
    ["home", "tmp"].includes(value.rootId as string) &&
    typeof value.path === "string" &&
    Buffer.byteLength(value.path) <= EXPORT_LIMITS.maximumPathBytes + 1024 &&
    typeof value.name === "string" &&
    Buffer.byteLength(value.name) <= EXPORT_LIMITS.maximumPathBytes + 1024 &&
    ["file", "directory", "unsupported"].includes(value.kind as string) &&
    Number.isSafeInteger(value.size) &&
    (value.size as number) >= 0 &&
    isExportIdentity(value.identity) &&
    (value.problem === undefined ||
      (typeof value.problem === "string" && /^[a-z0-9_]{1,80}$/u.test(value.problem))) &&
    (value.kind === "unsupported" || validPath(value.path))
  );
}

export function isExportOperation(value: unknown): value is ExportOperation {
  if (!record(value)) return false;
  if (["begin", "read", "closeFile", "end"].includes(value.operation as string))
    return keys(value, ["operation"]);
  if (value.operation === "open")
    return keys(value, ["operation", "entry"]) && isExportEntry(value.entry);
  return (
    value.operation === "list" &&
    keys(value, [
      "operation",
      "rootId",
      "path",
      ...(value.cursor === undefined ? [] : ["cursor"]),
    ]) &&
    ["home", "tmp"].includes(value.rootId as string) &&
    validPath(value.path) &&
    (value.cursor === undefined ||
      (typeof value.cursor === "string" && /^\d{1,12}:\d{1,12}$/u.test(value.cursor)))
  );
}

export function isExportReply(value: unknown): value is ExportReply {
  if (!record(value)) return false;
  if (["open", "closeFile", "end"].includes(value.operation as string))
    return keys(value, ["operation"]);
  if (value.operation === "begin")
    return (
      keys(value, ["operation", "roots"]) &&
      Array.isArray(value.roots) &&
      value.roots.length >= 1 &&
      value.roots.length <= 2 &&
      value.roots.every(
        (root) =>
          record(root) &&
          keys(root, ["id", "label"]) &&
          ["home", "tmp"].includes(root.id as string) &&
          typeof root.label === "string" &&
          root.label.length <= 64,
      ) &&
      new Set(value.roots.map((root: unknown) => (record(root) ? root.id : undefined))).size ===
        value.roots.length
    );
  if (value.operation === "read")
    return (
      keys(value, ["operation", "data"]) &&
      typeof value.data === "string" &&
      value.data.length <= Math.ceil(EXPORT_LIMITS.chunkBytes / 3) * 4 &&
      Buffer.from(value.data, "base64").byteLength <= EXPORT_LIMITS.chunkBytes &&
      /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.data)
    );
  if (value.operation !== "list" || !keys(value, ["operation", "page"]) || !record(value.page))
    return false;
  const page = value.page;
  return (
    keys(page, ["entries", ...(page.nextCursor === undefined ? [] : ["nextCursor"])]) &&
    Array.isArray(page.entries) &&
    page.entries.length <= EXPORT_LIMITS.maximumPageEntries &&
    page.entries.every(isExportEntry) &&
    Buffer.byteLength(JSON.stringify(page)) <= EXPORT_LIMITS.maximumPageBytes + 1024 &&
    (page.nextCursor === undefined ||
      (typeof page.nextCursor === "string" && /^\d{1,12}:\d{1,12}$/u.test(page.nextCursor)))
  );
}

export async function runExportOperation(
  service: ExportFileService,
  request: ExportOperation,
): Promise<ExportReply> {
  switch (request.operation) {
    case "begin":
      return { operation: "begin", roots: service.begin() };
    case "list":
      return {
        operation: "list",
        page: await service.list(request.rootId, request.path, request.cursor),
      };
    case "open":
      await service.openFile(request.entry);
      return { operation: "open" };
    case "read":
      return { operation: "read", data: (await service.readChunk()).toString("base64") };
    case "closeFile":
      await service.closeFile();
      return { operation: "closeFile" };
    case "end":
      await service.end();
      return { operation: "end" };
  }
}

export function parseExportReaderConfiguration(raw: string): ExportReaderConfiguration {
  if (Buffer.byteLength(raw) > 16_384) throw new Error("export_reader_configuration_invalid");
  const value: unknown = JSON.parse(raw);
  if (
    !record(value) ||
    !keys(value, ["roots"]) ||
    !Array.isArray(value.roots) ||
    value.roots.length !== 2 ||
    !value.roots.every(
      (root) =>
        record(root) &&
        keys(root, ["id", "path", "identity"]) &&
        ["home", "tmp"].includes(root.id as string) &&
        typeof root.path === "string" &&
        root.path.startsWith("/") &&
        Buffer.byteLength(root.path) <= EXPORT_LIMITS.maximumPathBytes &&
        isExportIdentity(root.identity),
    ) ||
    new Set(value.roots.map((root: unknown) => (record(root) ? root.id : undefined))).size !== 2
  )
    throw new Error("export_reader_configuration_invalid");
  return value as unknown as ExportReaderConfiguration;
}
