import type { NetworkMode } from "../domain/index.js";

export const TOOL_COMMAND_NAMES = Object.freeze([
  "bash",
  "sh",
  "cat",
  "chmod",
  "mkdir",
  "mv",
  "rm",
  "grep",
  "file",
  "find",
  "awk",
  "head",
  "sha256sum",
  "sort",
  "tail",
  "test",
  "wc",
] as const);

export type ToolCommandName = (typeof TOOL_COMMAND_NAMES)[number];
export type ToolCommandPaths = Readonly<Record<ToolCommandName, string>>;

export const DEFAULT_SANDBOX_TIMEOUT_MS = 120_000;
export const DEFAULT_SANDBOX_OUTPUT_LIMIT_BYTES = 1_048_576;

export interface SandboxResourceLimits {
  readonly defaultTimeoutMs?: number;
  readonly maximumTimeoutMs?: number;
  readonly defaultOutputBytes?: number;
  readonly maximumOutputBytes?: number;
  readonly maximumInputBytes?: number;
  readonly maximumArgumentBytes?: number;
}

export interface CreateBubblewrapExecutorOptions {
  /** The launch directory, explicitly mounted at the identical host path. */
  readonly cwd: string;
  /** Whether the launch directory permits host writes. Omitted means writable. */
  readonly cwdWritable?: boolean;
  /** Existing canonical absolute files and directories masked from sandboxed tools. */
  readonly hiddenPaths?: readonly string[];
  /** Tool and shell network authority. Omitted means a private offline namespace. */
  readonly networkMode?: NetworkMode;
  /** Administrator-provided variables added to the fixed sandbox environment. */
  readonly environment?: Readonly<Record<string, string>>;
  /** Absolute build-selected Bubblewrap executable. No runtime default or fallback exists. */
  readonly bubblewrapPath: string;
  readonly limits?: SandboxResourceLimits;
  /** Alternate worker entry point used by source-level integration tests. */
  readonly workerCommand?: readonly [string, ...string[]];
}

export interface SandboxCommandRequest {
  /** Direct executable and arguments. A host shell is never implied. */
  readonly argv: readonly [string, ...string[]];
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs?: number;
  /** Combined stdout and stderr byte limit. */
  readonly maxOutputBytes?: number;
}

export interface SandboxExecutionOptions {
  readonly signal?: AbortSignal;
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
}

export interface SandboxCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export type SandboxExecutionErrorCode =
  | "sandbox_aborted"
  | "sandbox_closed"
  | "sandbox_input_too_large"
  | "sandbox_invalid_request"
  | "sandbox_output_limit_exceeded"
  | "sandbox_process_failed"
  | "sandbox_start_failed"
  | "sandbox_timeout";

export class SandboxExecutionError extends Error {
  readonly code: SandboxExecutionErrorCode;

  constructor(code: SandboxExecutionErrorCode, options?: { readonly cause?: unknown }) {
    super(code, options);
    this.name = "SandboxExecutionError";
    this.code = code;
  }
}

export interface SandboxExecutor {
  readonly cwd: string;
  readonly home: string;
  readonly backend: "bubblewrap" | "direct";
  readonly commands: ToolCommandPaths;
  probe(signal?: AbortSignal): Promise<void>;
  execute(
    request: SandboxCommandRequest,
    options?: SandboxExecutionOptions,
  ): Promise<SandboxCommandResult>;
  close(): Promise<void>;
}
