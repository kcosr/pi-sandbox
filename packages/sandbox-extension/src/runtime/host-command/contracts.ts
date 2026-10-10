export const DEFAULT_HOST_COMMAND_TIMEOUT_MS = 120_000;
export const DEFAULT_HOST_COMMAND_OUTPUT_LIMIT_BYTES = 1_048_576;

export interface HostCommandResourceLimits {
  readonly defaultTimeoutMs?: number;
  readonly maximumTimeoutMs?: number;
  readonly defaultOutputBytes?: number;
  readonly maximumOutputBytes?: number;
  readonly maximumInputBytes?: number;
  readonly maximumArgumentBytes?: number;
  readonly terminationGraceMs?: number;
}

export interface CreateHostCommandExecutorOptions {
  /** Fixed launch directory used by every host command. */
  readonly cwd: string;
  readonly limits?: HostCommandResourceLimits;
  /** Alternate inherited environment used by tests and embedding runtimes. */
  readonly environment?: NodeJS.ProcessEnv;
}

export interface HostCommandRequest {
  /** Direct absolute executable and arguments. A shell is never involved. */
  readonly argv: readonly [string, ...string[]];
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs?: number;
  /** Combined stdout and stderr byte limit. */
  readonly maxOutputBytes?: number;
}

export interface HostCommandExecutionOptions {
  readonly signal?: AbortSignal;
  readonly onStdout?: (chunk: Buffer) => void;
  readonly onStderr?: (chunk: Buffer) => void;
}

export interface HostCommandResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

export type HostCommandExecutionErrorCode =
  | "host_command_aborted"
  | "host_command_closed"
  | "host_command_input_too_large"
  | "host_command_invalid_request"
  | "host_command_output_limit_exceeded"
  | "host_command_process_failed"
  | "host_command_start_failed"
  | "host_command_timeout";

export class HostCommandExecutionError extends Error {
  readonly code: HostCommandExecutionErrorCode;

  constructor(code: HostCommandExecutionErrorCode, options?: { readonly cause?: unknown }) {
    super(code, options);
    this.name = "HostCommandExecutionError";
    this.code = code;
  }
}

export interface HostCommandExecutor {
  readonly cwd: string;
  execute(
    request: HostCommandRequest,
    options?: HostCommandExecutionOptions,
  ): Promise<HostCommandResult>;
  close(): Promise<void>;
}
