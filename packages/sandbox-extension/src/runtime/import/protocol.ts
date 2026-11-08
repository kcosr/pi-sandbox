import { assertImportPath, IMPORT_LIMITS, type SandboxImportDirectory } from "./contracts.js";

export type ImportOperation =
  | {
      readonly operation: "begin" | "finish" | "verifyDirectory" | "close";
      readonly sessionId: string;
    }
  | { readonly operation: "write"; readonly sessionId: string; readonly data: string }
  | { readonly operation: "reserveDirectory"; readonly sessionId: string; readonly path: string };

export type ImportReply =
  | { readonly operation: "begin" | "write" | "verifyDirectory" | "close" }
  | { readonly operation: "finish"; readonly path: string }
  | { readonly operation: "reserveDirectory"; readonly directory: SandboxImportDirectory };

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function keys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return (
    Object.keys(value).length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}
function validPath(value: unknown): boolean {
  try {
    assertImportPath(value);
    return true;
  } catch {
    return false;
  }
}
export function isImportOperation(value: unknown): value is ImportOperation {
  if (
    !record(value) ||
    typeof value.sessionId !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(value.sessionId)
  )
    return false;
  if (["begin", "finish", "verifyDirectory", "close"].includes(value.operation as string))
    return keys(value, ["operation", "sessionId"]);
  if (value.operation === "reserveDirectory")
    return keys(value, ["operation", "sessionId", "path"]) && validPath(value.path);
  return (
    value.operation === "write" &&
    keys(value, ["operation", "sessionId", "data"]) &&
    typeof value.data === "string" &&
    value.data.length > 0 &&
    value.data.length <= Math.ceil(IMPORT_LIMITS.chunkBytes / 3) * 4 &&
    /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value.data) &&
    Buffer.from(value.data, "base64").byteLength <= IMPORT_LIMITS.chunkBytes
  );
}
export function isImportReply(value: unknown): value is ImportReply {
  if (!record(value)) return false;
  if (["begin", "write", "verifyDirectory", "close"].includes(value.operation as string))
    return keys(value, ["operation"]);
  if (value.operation === "finish")
    return keys(value, ["operation", "path"]) && isDescriptorPath(value.path);
  return (
    value.operation === "reserveDirectory" &&
    keys(value, ["operation", "directory"]) &&
    record(value.directory) &&
    keys(value.directory, ["path", "displayPath"]) &&
    isDescriptorPath(value.directory.path) &&
    typeof value.directory.displayPath === "string" &&
    value.directory.displayPath.startsWith("/run/pi-sandbox/home/") &&
    validPath(value.directory.displayPath.slice("/run/pi-sandbox/home/".length))
  );
}
function isDescriptorPath(value: unknown): value is string {
  return typeof value === "string" && /^\/proc\/[1-9][0-9]*\/fd\/[0-9]+$/u.test(value);
}
