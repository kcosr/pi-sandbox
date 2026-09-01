import { TOOL_NAMES } from "../domain/index.js";
import {
  MANAGED_EXTENSION_API_VERSION,
  type CompiledExtension,
  type CompiledExtensionRecord,
  type JsonObject,
  type ManagedToolDefinition,
  type PiToolExtension,
} from "./contracts.js";
import { parseManagedHostEnvironment } from "./sdk.js";

const EXTENSION_ID_PATTERN = /^[a-z][a-z0-9-]{0,63}$/u;
const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/u;
const DIAGNOSTIC_SCOPE_PATTERN = /^[a-z][a-z0-9_.-]{0,127}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const SEMVER_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u;
const RESERVED_TOOL_NAMES = new Set<string>([...TOOL_NAMES, "user_shell"]);
const RECORD_KEYS = new Set(["manifest", "extension"]);
const MANIFEST_KEYS = new Set(["kind", "apiVersion", "id", "version", "toolNames", "digests"]);
const DIGEST_KEYS = new Set(["manifestSha256", "moduleSha256"]);
const EXTENSION_KEYS = new Set([
  "kind",
  "apiVersion",
  "id",
  "version",
  "hostEnvironment",
  "parseConfig",
  "requiredHostExecutables",
  "tools",
  "toolNames",
  "factory",
]);
const TOOL_KEYS = new Set([
  "name",
  "label",
  "description",
  "promptSnippet",
  "promptGuidelines",
  "parameters",
  "diagnosticScope",
  "executionMode",
  "formatCall",
  "execute",
]);

export interface CatalogTool {
  readonly extensionId: string;
  readonly definition: ManagedToolDefinition | undefined;
}

export interface ManagedExtensionCatalog {
  readonly extensions: readonly CompiledExtension[];
  readonly tools: readonly CatalogTool[];
  readonly toolNames: readonly string[];
  getExtension(id: string): CompiledExtension | undefined;
  getTool(name: string): CatalogTool | undefined;
}

export function createManagedExtensionCatalog(
  records: readonly CompiledExtensionRecord[],
): ManagedExtensionCatalog {
  const extensions = new Map<string, CompiledExtension>();
  const tools = new Map<string, CatalogTool>();
  const diagnosticScopes = new Set<string>();

  for (const [index, record] of records.entries()) {
    validateRecord(record, `compiledExtensions[${index}]`);
    const { extension, manifest } = record;
    if (extensions.has(extension.id)) throw new Error(`duplicate extension id: ${extension.id}`);
    extensions.set(extension.id, extension);

    if (extension.kind === "managed") {
      for (const [toolIndex, definition] of extension.tools.entries()) {
        const path = `extension ${extension.id} tools[${toolIndex}]`;
        validateTool(definition, path);
        const name = definition.name;
        if (RESERVED_TOOL_NAMES.has(name)) {
          throw new Error(`extension tool collides with reserved tool: ${name}`);
        }
        if (tools.has(name)) throw new Error(`duplicate extension tool name: ${name}`);
        if (diagnosticScopes.has(definition.diagnosticScope)) {
          throw new Error(
            `duplicate managed extension diagnostic scope: ${definition.diagnosticScope}`,
          );
        }
        diagnosticScopes.add(definition.diagnosticScope);
        tools.set(name, Object.freeze({ extensionId: manifest.id, definition }));
      }
      continue;
    }
    for (const [toolIndex, name] of extension.toolNames.entries()) {
      const path = `extension ${extension.id} tools[${toolIndex}]`;
      if (typeof name !== "string" || !TOOL_NAME_PATTERN.test(name)) {
        throw new Error(`${path} is invalid`);
      }
      if (RESERVED_TOOL_NAMES.has(name)) {
        throw new Error(`extension tool collides with reserved tool: ${name}`);
      }
      if (tools.has(name)) throw new Error(`duplicate extension tool name: ${name}`);
      tools.set(name, Object.freeze({ extensionId: manifest.id, definition: undefined }));
    }
  }

  const extensionValues = Object.freeze([...extensions.values()]);
  const toolValues = Object.freeze([...tools.values()]);
  const toolNames = Object.freeze([...tools.keys()]);
  return Object.freeze({
    extensions: extensionValues,
    tools: toolValues,
    toolNames,
    getExtension: (id: string) => extensions.get(id),
    getTool: (name: string) => tools.get(name),
  });
}

function validateRecord(record: CompiledExtensionRecord, path: string): void {
  if (!isPlainObject(record)) throw new Error(`${path} must be an object`);
  rejectUnknownKeys(record, RECORD_KEYS, path);
  const { manifest, extension } = record;
  if (!isPlainObject(manifest)) throw new Error(`${path}.manifest must be an object`);
  if (!isPlainObject(extension)) throw new Error(`${path}.extension must be an object`);
  rejectUnknownKeys(manifest, MANIFEST_KEYS, `${path}.manifest`);
  rejectUnknownKeys(extension, EXTENSION_KEYS, `${path}.extension`);
  if (manifest.kind !== "managed" && manifest.kind !== "pi-tool") {
    throw new Error(`${path}.manifest.kind is invalid`);
  }
  if (extension.kind !== manifest.kind) throw new Error(`${path} manifest and module kinds differ`);
  validateApiVersion(manifest.apiVersion, `${path}.manifest.apiVersion`);
  validateApiVersion(extension.apiVersion, `${path}.extension.apiVersion`);
  validateExtensionId(manifest.id, `${path}.manifest.id`);
  validateExtensionId(extension.id, `${path}.extension.id`);
  validateVersion(manifest.version, `${path}.manifest.version`);
  validateVersion(extension.version, `${path}.extension.version`);
  if (manifest.id !== extension.id) throw new Error(`${path} manifest and module ids differ`);
  if (manifest.version !== extension.version)
    throw new Error(`${path} manifest and module versions differ`);
  if (!Array.isArray(manifest.toolNames)) {
    throw new Error(`${path}.manifest.toolNames must be an array`);
  }
  parseManagedHostEnvironment(extension.hostEnvironment, `${path}.extension.hostEnvironment`);
  if (!isPlainObject(manifest.digests))
    throw new Error(`${path}.manifest.digests must be an object`);
  rejectUnknownKeys(manifest.digests, DIGEST_KEYS, `${path}.manifest.digests`);
  validateDigest(manifest.digests.manifestSha256, `${path}.manifest.digests.manifestSha256`);
  validateDigest(manifest.digests.moduleSha256, `${path}.manifest.digests.moduleSha256`);
  if (typeof extension.parseConfig !== "function") {
    throw new Error(`${path}.extension.parseConfig must be a function`);
  }
  if (typeof extension.requiredHostExecutables !== "function") {
    throw new Error(`${path}.extension.requiredHostExecutables must be a function`);
  }
  if (extension.kind === "managed") {
    if (!Array.isArray(extension.tools))
      throw new Error(`${path}.extension.tools must be an array`);
    const names = (extension.tools as readonly ManagedToolDefinition[]).map((tool) => tool.name);
    if (JSON.stringify(manifest.toolNames) !== JSON.stringify(names)) {
      throw new Error(`${path} manifest and managed tool names differ`);
    }
  } else {
    validatePiToolExtension(extension, path);
    if (JSON.stringify(manifest.toolNames) !== JSON.stringify(extension.toolNames)) {
      throw new Error(`${path} manifest and Pi tool names differ`);
    }
  }
}

function validatePiToolExtension(extension: PiToolExtension, path: string): void {
  if (!Array.isArray(extension.toolNames) || extension.toolNames.length === 0) {
    throw new Error(`${path}.extension.toolNames must be a nonempty array`);
  }
  if (new Set(extension.toolNames).size !== extension.toolNames.length) {
    throw new Error(`${path}.extension.toolNames must not contain duplicates`);
  }
  if (typeof extension.factory !== "function") {
    throw new Error(`${path}.extension.factory must be a function`);
  }
}

function validateTool(tool: ManagedToolDefinition, path: string): void {
  if (!isPlainObject(tool)) throw new Error(`${path} must be an object`);
  rejectUnknownKeys(tool, TOOL_KEYS, path);
  if (!TOOL_NAME_PATTERN.test(tool.name)) throw new Error(`${path}.name is invalid`);
  validateNonemptyString(tool.label, `${path}.label`);
  validateNonemptyString(tool.description, `${path}.description`);
  if (tool.promptSnippet !== undefined)
    validateNonemptyString(tool.promptSnippet, `${path}.promptSnippet`);
  if (tool.promptGuidelines !== undefined) {
    if (!Array.isArray(tool.promptGuidelines))
      throw new Error(`${path}.promptGuidelines must be an array`);
    tool.promptGuidelines.forEach((guideline, index) =>
      validateNonemptyString(guideline, `${path}.promptGuidelines[${index}]`),
    );
  }
  if (!DIAGNOSTIC_SCOPE_PATTERN.test(tool.diagnosticScope)) {
    throw new Error(`${path}.diagnosticScope is invalid`);
  }
  if (
    tool.executionMode !== undefined &&
    tool.executionMode !== "parallel" &&
    tool.executionMode !== "sequential"
  ) {
    throw new Error(`${path}.executionMode is invalid`);
  }
  if (tool.formatCall !== undefined && typeof tool.formatCall !== "function") {
    throw new Error(`${path}.formatCall must be a function`);
  }
  if (typeof tool.execute !== "function") throw new Error(`${path}.execute must be a function`);
  validateToolSchema(tool.parameters, `${path}.parameters`);
}

function validateToolSchema(schema: JsonObject, path: string): void {
  validateJsonValue(schema, path, new Set());
  if (schema.type !== "object") throw new Error(`${path}.type must be object`);
  if (schema.properties !== undefined && !isPlainObject(schema.properties)) {
    throw new Error(`${path}.properties must be an object`);
  }
  if (schema.required !== undefined) {
    if (
      !Array.isArray(schema.required) ||
      schema.required.some((entry) => typeof entry !== "string")
    ) {
      throw new Error(`${path}.required must be an array of strings`);
    }
    if (new Set(schema.required).size !== schema.required.length) {
      throw new Error(`${path}.required must not contain duplicates`);
    }
  }
  if (
    schema.additionalProperties !== undefined &&
    typeof schema.additionalProperties !== "boolean" &&
    !isPlainObject(schema.additionalProperties)
  ) {
    throw new Error(`${path}.additionalProperties must be a boolean or schema object`);
  }
}

function validateJsonValue(value: unknown, path: string, ancestors: Set<object>): void {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${path} contains a non-finite number`);
    return;
  }
  if (typeof value !== "object") throw new Error(`${path} contains a non-JSON value`);
  if (ancestors.has(value)) throw new Error(`${path} contains a cycle`);
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => validateJsonValue(entry, `${path}[${index}]`, ancestors));
      return;
    }
    if (!isPlainObject(value)) throw new Error(`${path} contains a non-plain object`);
    for (const [key, entry] of Object.entries(value)) {
      validateJsonValue(entry, `${path}.${key}`, ancestors);
    }
  } finally {
    ancestors.delete(value);
  }
}

function validateApiVersion(value: unknown, path: string): void {
  if (value !== MANAGED_EXTENSION_API_VERSION) {
    throw new Error(`${path} must be ${MANAGED_EXTENSION_API_VERSION}`);
  }
}

function validateExtensionId(value: unknown, path: string): void {
  if (typeof value !== "string" || !EXTENSION_ID_PATTERN.test(value)) {
    throw new Error(`${path} is invalid`);
  }
}

function validateVersion(value: unknown, path: string): void {
  if (typeof value !== "string") throw new Error(`${path} is invalid`);
  const match = SEMVER_PATTERN.exec(value);
  const prerelease = match?.[4];
  if (
    match === null ||
    (prerelease !== undefined &&
      prerelease
        .split(".")
        .some(
          (identifier) =>
            /^\d+$/u.test(identifier) && identifier !== "0" && identifier.startsWith("0"),
        ))
  ) {
    throw new Error(`${path} is invalid`);
  }
}

function validateDigest(value: unknown, path: string): void {
  if (typeof value !== "string" || !SHA256_PATTERN.test(value)) {
    throw new Error(`${path} must be a lowercase SHA-256 digest`);
  }
}

function validateNonemptyString(value: unknown, path: string): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${path} must be a nonempty string`);
  }
}

function rejectUnknownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${path}.${key} is not a recognized field`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype === Object.prototype || prototype === null;
}
