import type {
  FrozenJsonObject,
  FrozenJsonValue,
  JsonObject,
  ManagedExtension,
  ManagedHostEnvironment,
  ManagedExtensionInstance,
  ManagedToolDefinition,
} from "./contracts.js";
import { isAbsolute, normalize } from "node:path";

export type {
  CompiledExtensionManifest,
  CompiledExtensionRecord,
  FrozenJsonObject,
  FrozenJsonValue,
  HostCommandExecutionOptions,
  HostCommandExecutor,
  HostCommandRequest,
  HostCommandResult,
  JsonObject,
  JsonObjectSchema,
  JsonPrimitive,
  JsonValue,
  ManagedExtension,
  ManagedExtensionDigests,
  ManagedExtensionInstance,
  ManagedHostEnvironment,
  ManagedToolContent,
  ManagedToolDefinition,
  ManagedToolExecutionContext,
  ManagedToolImageContent,
  ManagedToolResult,
  ManagedToolTextContent,
  PiToolExtension,
  ExtensionKind,
} from "./contracts.js";
export { MANAGED_EXTENSION_API_VERSION } from "./contracts.js";

const HOST_ENVIRONMENT_KEYS = new Set([
  "variables",
  "removeInherited",
  "removeInheritedPrefixes",
  "fixed",
]);
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const INTERNAL_ENVIRONMENT_PREFIX = "PI_SANDBOX_";

/** Preserve an extension's generic tool types without introducing runtime state. */
export function defineManagedExtension<const T extends ManagedExtension>(extension: T): T {
  return extension;
}

/** Validate, clone, and deeply freeze a managed extension's static host environment policy. */
export function defineManagedHostEnvironment(
  value: ManagedHostEnvironment,
): ManagedHostEnvironment {
  return parseManagedHostEnvironment(value, "hostEnvironment");
}

export function parseManagedHostEnvironment(value: unknown, path: string): ManagedHostEnvironment {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
  for (const key of Object.keys(value)) {
    if (!HOST_ENVIRONMENT_KEYS.has(key)) {
      throw new Error(`${path}.${key} is not a recognized field`);
    }
  }
  if (!Object.hasOwn(value, "variables")) throw new Error(`${path}.variables is required`);

  const variables = parseEnvironmentNames(value.variables, `${path}.variables`, true);
  const removeInherited = Object.hasOwn(value, "removeInherited")
    ? parseEnvironmentNames(value.removeInherited, `${path}.removeInherited`, false)
    : undefined;
  const removeInheritedPrefixes = Object.hasOwn(value, "removeInheritedPrefixes")
    ? parseEnvironmentNames(value.removeInheritedPrefixes, `${path}.removeInheritedPrefixes`, false)
    : undefined;
  const fixed = Object.hasOwn(value, "fixed")
    ? parseFixedEnvironment(value.fixed, `${path}.fixed`)
    : undefined;

  return Object.freeze({
    variables,
    ...(removeInherited === undefined ? {} : { removeInherited }),
    ...(removeInheritedPrefixes === undefined ? {} : { removeInheritedPrefixes }),
    ...(fixed === undefined ? {} : { fixed }),
  });
}

/** Preserve a standalone tool's argument and detail types. */
export function defineManagedTool<
  TArguments extends JsonObject,
  TDetails extends FrozenJsonValue | undefined = undefined,
>(tool: ManagedToolDefinition<TArguments, TDetails>): ManagedToolDefinition<TArguments, TDetails> {
  return tool;
}

/** Clone, validate, and deeply freeze a parsed extension configuration object. */
export function freezeExtensionConfig(value: JsonObject): FrozenJsonObject {
  return freezeJsonValue(value, "config", new Set()) as FrozenJsonObject;
}

export function parseManagedExtensionConfig(
  extension: ManagedExtension,
  raw: unknown,
  path: string,
): FrozenJsonObject {
  if (path.length === 0) throw new Error("extension configuration path must not be empty");
  const config = extension.parseConfig(raw, path);
  assertDeeplyFrozenJson(config, path, new Set());
  return config;
}

export function instantiateManagedExtension(
  extension: ManagedExtension,
  config: FrozenJsonObject,
): ManagedExtensionInstance {
  assertDeeplyFrozenJson(config, "config", new Set());
  const hostEnvironment = parseManagedHostEnvironment(
    extension.hostEnvironment,
    `extension ${extension.id} hostEnvironment`,
  );
  const executablePaths = extension.requiredHostExecutables(config);
  if (!Array.isArray(executablePaths)) {
    throw new Error(`extension ${extension.id} requiredHostExecutables must return an array`);
  }
  const unique = new Set<string>();
  for (const [index, path] of executablePaths.entries()) {
    if (
      typeof path !== "string" ||
      path.length === 0 ||
      path.includes("\0") ||
      !isAbsolute(path) ||
      normalize(path) !== path
    ) {
      throw new Error(
        `extension ${extension.id} requiredHostExecutables[${index}] must be a normalized absolute path`,
      );
    }
    if (unique.has(path)) {
      throw new Error(`extension ${extension.id} declares duplicate host executable: ${path}`);
    }
    unique.add(path);
  }
  return Object.freeze({
    extension,
    config,
    hostEnvironment,
    requiredHostExecutables: Object.freeze([...unique]),
  });
}

function parseEnvironmentNames(
  value: unknown,
  path: string,
  rejectInternal: boolean,
): readonly string[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  const names: string[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== "string" || !ENVIRONMENT_NAME_PATTERN.test(entry)) {
      throw new Error(`${path}[${index}] is not a valid environment variable name`);
    }
    if (rejectInternal && entry.startsWith(INTERNAL_ENVIRONMENT_PREFIX)) {
      throw new Error(`${path}[${index}] must not accept a reserved internal variable`);
    }
    if (seen.has(entry)) throw new Error(`${path} must not contain duplicates`);
    seen.add(entry);
    names.push(entry);
  }
  return Object.freeze(names);
}

function parseFixedEnvironment(value: unknown, path: string): Readonly<Record<string, string>> {
  if (!isPlainObject(value)) throw new Error(`${path} must be an object`);
  const fixed: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (!ENVIRONMENT_NAME_PATTERN.test(name)) {
      throw new Error(`${path}.${name} is not a valid environment variable name`);
    }
    if (name.startsWith(INTERNAL_ENVIRONMENT_PREFIX)) {
      throw new Error(`${path}.${name} must not set a reserved internal variable`);
    }
    if (typeof entry !== "string" || entry.includes("\0")) {
      throw new Error(`${path}.${name} must be a string without NUL bytes`);
    }
    fixed[name] = entry;
  }
  return Object.freeze(fixed);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}

function freezeJsonValue(value: unknown, path: string, ancestors: Set<object>): FrozenJsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers`);
    return value;
  }
  if (typeof value !== "object") throw new Error(`${path} must contain only JSON values`);
  if (ancestors.has(value)) throw new Error(`${path} must not contain cycles`);

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return Object.freeze(
        value.map((entry, index) => freezeJsonValue(entry, `${path}[${index}]`, ancestors)),
      );
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects`);
    }
    const output: Record<string, FrozenJsonValue> = {};
    for (const key of Object.keys(value)) {
      output[key] = freezeJsonValue(
        (value as Record<string, unknown>)[key],
        `${path}.${key}`,
        ancestors,
      );
    }
    return Object.freeze(output);
  } finally {
    ancestors.delete(value);
  }
}

function assertDeeplyFrozenJson(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} must contain only finite JSON numbers`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} must contain only JSON values`);
  if (!Object.isFrozen(value)) throw new Error(`${path} must be deeply frozen`);
  if (ancestors.has(value)) throw new Error(`${path} must not contain cycles`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        assertDeeplyFrozenJson(entry, `${path}[${index}]`, ancestors),
      );
      return;
    }
    const prototype = Object.getPrototypeOf(value) as object | null;
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${path} must contain only plain JSON objects`);
    }
    for (const [key, entry] of Object.entries(value)) {
      assertDeeplyFrozenJson(entry, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}
