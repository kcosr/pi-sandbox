export const TOOL_NAMES = Object.freeze([
  "read",
  "grep",
  "find",
  "ls",
  "write",
  "edit",
  "bash",
] as const);

export type BuiltInToolName = (typeof TOOL_NAMES)[number];
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;
export interface JsonObject {
  readonly [key: string]: JsonValue;
}

/** A detached invocation snapshot; its owner supplies authorization, if required. */
export interface SandboxToolRequest {
  readonly subject: BuiltInToolName;
  readonly arguments: JsonObject;
}

/** Canonical JSON serialization shared by the execution and managed approval boundaries. */
export function canonicalizeJson(
  value: JsonValue,
  path = "arguments",
  ancestors = new Set<object>(),
): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (typeof value !== "object") throw new Error(`${path} contains a non-JSON value`);
  if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const items = value as readonly JsonValue[];
      return `[${Array.from(items, (item, index) =>
        canonicalizeJson(item, `${path}[${index}]`, ancestors),
      ).join(",")}]`;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects`);
    }
    const object = value as JsonObject;
    return `{${Object.keys(object)
      .sort()
      .map(
        (key) =>
          `${JSON.stringify(key)}:${canonicalizeJson(object[key] as JsonValue, `${path}.${key}`, ancestors)}`,
      )
      .join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

/** Round-trip before freezing so approval and execution observe identical JSON values. */
export function snapshotJsonObject(input: JsonObject): JsonObject {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Tool arguments must be a JSON object");
  }
  // JSON.parse preserves an own __proto__ data property without invoking a setter.
  const copy = JSON.parse(canonicalizeJson(input)) as JsonObject;
  deepFreeze(copy);
  return copy;
}

export function prepareSandboxToolRequest(
  subject: BuiltInToolName,
  arguments_: JsonObject,
): SandboxToolRequest {
  return Object.freeze({ subject, arguments: snapshotJsonObject(arguments_) });
}

function deepFreeze(value: JsonValue): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) deepFreeze(child);
  Object.freeze(value);
}
