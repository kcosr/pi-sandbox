import type { HostCommandRequest, HostCommandResult } from "../host/contracts.js";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";

export type { HostCommandRequest, HostCommandResult } from "../host/contracts.js";

export const MANAGED_EXTENSION_API_VERSION = 3 as const;

export const EXTENSION_KINDS = Object.freeze(["managed", "pi-tool"] as const);
export type ExtensionKind = (typeof EXTENSION_KINDS)[number];

export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export type FrozenJsonValue = JsonPrimitive | readonly FrozenJsonValue[] | FrozenJsonObject;

export interface FrozenJsonObject {
  readonly [key: string]: FrozenJsonValue;
}

/** A plain JSON Schema whose root describes the tool's argument object. */
export interface JsonObjectSchema extends JsonObject {
  readonly type: "object";
}

export interface HostCommandExecutionOptions {
  readonly signal?: AbortSignal;
}

/** Restricted extension view of the centrally owned host command executor. */
export interface HostCommandExecutor {
  execute(
    request: HostCommandRequest,
    options?: HostCommandExecutionOptions,
  ): Promise<HostCommandResult>;
}

export interface ManagedToolExecutionContext {
  readonly cwd: string;
  readonly config: FrozenJsonObject;
  readonly signal: AbortSignal;
  readonly host: HostCommandExecutor;
}

/** Trusted, build-time environment policy for one managed extension. */
export interface ManagedHostEnvironment {
  /** Per-user variable names that this extension accepts from the identity broker. */
  readonly variables: readonly string[];
  /** Exact inherited variable names removed before identity-scoped values are applied. */
  readonly removeInherited?: readonly string[];
  /** Inherited variable-name prefixes removed before identity-scoped values are applied. */
  readonly removeInheritedPrefixes?: readonly string[];
  /** Fixed values applied by the compiled extension policy. */
  readonly fixed?: Readonly<Record<string, string>>;
}

export interface ManagedToolTextContent {
  readonly type: "text";
  readonly text: string;
}

export interface ManagedToolImageContent {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

export type ManagedToolContent = ManagedToolTextContent | ManagedToolImageContent;

export interface ManagedToolResult<TDetails extends JsonValue | undefined = undefined> {
  readonly content: ManagedToolContent[];
  readonly details: TDetails;
}

export interface ManagedToolDefinition<
  TArguments extends JsonObject = JsonObject,
  TDetails extends JsonValue | undefined = undefined,
> {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: JsonObjectSchema;
  readonly diagnosticScope: string;
  readonly executionMode?: "parallel" | "sequential";
  /** Return a short, single-line, non-sensitive summary for Pi's tool-call card. */
  formatCall?(arguments_: Readonly<Partial<TArguments>>): string | undefined;
  /** Select identifying target metadata without file content or arbitrary argument logging. */
  auditTarget?(
    this: void,
    arguments_: Readonly<TArguments>,
    cwd: string,
  ): { readonly path?: string; readonly repository?: string };
  execute(
    arguments_: Readonly<TArguments>,
    context: ManagedToolExecutionContext,
  ): Promise<ManagedToolResult<TDetails>>;
}

export interface ManagedExtension {
  readonly kind: "managed";
  readonly apiVersion: typeof MANAGED_EXTENSION_API_VERSION;
  readonly id: string;
  readonly version: string;
  readonly hostEnvironment: ManagedHostEnvironment;
  parseConfig(raw: unknown, path: string): FrozenJsonObject;
  requiredHostExecutables(config: FrozenJsonObject): readonly string[];
  readonly tools: readonly ManagedToolDefinition[];
}

/** A standard Pi extension restricted to registering a fixed tool set at startup. */
export interface PiToolExtension {
  readonly kind: "pi-tool";
  readonly apiVersion: typeof MANAGED_EXTENSION_API_VERSION;
  readonly id: string;
  readonly version: string;
  readonly hostEnvironment: ManagedHostEnvironment;
  parseConfig(raw: unknown, path: string): FrozenJsonObject;
  requiredHostExecutables(config: FrozenJsonObject): readonly string[];
  readonly toolNames: readonly string[];
  readonly factory: ExtensionFactory;
}

export type CompiledExtension = ManagedExtension | PiToolExtension;

export interface ManagedExtensionInstance {
  readonly extension: ManagedExtension;
  readonly config: FrozenJsonObject;
  readonly hostEnvironment: ManagedHostEnvironment;
  readonly requiredHostExecutables: readonly string[];
}

export interface CompiledExtensionManifest {
  readonly kind: ExtensionKind;
  readonly apiVersion: typeof MANAGED_EXTENSION_API_VERSION;
  readonly id: string;
  readonly version: string;
  readonly toolNames: readonly string[];
  readonly digests: ManagedExtensionDigests;
}

export interface ManagedExtensionDigests {
  readonly manifestSha256: string;
  readonly moduleSha256: string;
}

/** A build-generated record containing one external module's default export. */
export interface CompiledExtensionRecord {
  readonly manifest: CompiledExtensionManifest;
  readonly extension: CompiledExtension;
}
