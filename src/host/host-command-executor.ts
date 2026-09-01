import { spawn, type ChildProcess } from "node:child_process";
import path from "node:path";

import {
  DEFAULT_HOST_COMMAND_OUTPUT_LIMIT_BYTES,
  DEFAULT_HOST_COMMAND_TIMEOUT_MS,
  HostCommandExecutionError,
  type CreateHostCommandExecutorOptions,
  type HostCommandExecutionOptions,
  type HostCommandExecutor,
  type HostCommandRequest,
  type HostCommandResult,
} from "./contracts.js";

const DEFAULT_MAXIMUM_TIMEOUT_MS = 600_000;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 64 * 1_048_576;
const DEFAULT_MAXIMUM_INPUT_BYTES = 64 * 1_048_576;
const DEFAULT_MAXIMUM_ARGUMENT_BYTES = 1_048_576;
const DEFAULT_TERMINATION_GRACE_MS = 750;

interface ResolvedLimits {
  readonly defaultTimeoutMs: number;
  readonly maximumTimeoutMs: number;
  readonly defaultOutputBytes: number;
  readonly maximumOutputBytes: number;
  readonly maximumInputBytes: number;
  readonly maximumArgumentBytes: number;
  readonly terminationGraceMs: number;
}

interface ValidatedRequest {
  readonly argv: readonly [string, ...string[]];
  readonly stdin: Buffer;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

interface ActiveCommand {
  readonly child: ChildProcess;
  readonly done: Promise<void>;
  fail(error: HostCommandExecutionError): void;
}

export function createHostCommandExecutor(
  options: CreateHostCommandExecutorOptions,
): HostCommandExecutor {
  const cwd = path.normalize(options.cwd);
  if (!path.isAbsolute(options.cwd) || cwd !== options.cwd || hasNul(options.cwd)) {
    throw new HostCommandExecutionError("host_command_start_failed", {
      cause: new Error("host_command_cwd_invalid"),
    });
  }
  return new ProcessHostCommandExecutor(
    cwd,
    resolveLimits(options),
    inheritedHostEnvironment(options.environment ?? process.env),
  );
}

class ProcessHostCommandExecutor implements HostCommandExecutor {
  readonly #active = new Set<ActiveCommand>();
  #closed = false;

  public constructor(
    public readonly cwd: string,
    private readonly limits: ResolvedLimits,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  public execute(
    request: HostCommandRequest,
    options: HostCommandExecutionOptions = {},
  ): Promise<HostCommandResult> {
    if (this.#closed) {
      return Promise.reject(new HostCommandExecutionError("host_command_closed"));
    }

    let validated: ValidatedRequest;
    try {
      validated = validateRequest(request, this.limits);
    } catch (error) {
      return Promise.reject(
        error instanceof Error
          ? error
          : new HostCommandExecutionError("host_command_invalid_request", { cause: error }),
      );
    }
    if (options.signal?.aborted === true) {
      return Promise.reject(new HostCommandExecutionError("host_command_aborted"));
    }

    return new Promise<HostCommandResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawn(validated.argv[0], validated.argv.slice(1), {
          cwd: this.cwd,
          env: this.environment,
          shell: false,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
        });
      } catch (cause) {
        reject(new HostCommandExecutionError("host_command_process_failed", { cause }));
        return;
      }

      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      let outputBytes = 0;
      let failure: HostCommandExecutionError | undefined;
      let settled = false;
      let terminationTimer: NodeJS.Timeout | undefined;
      let finishDone!: () => void;
      const done = new Promise<void>((doneResolve) => {
        finishDone = doneResolve;
      });

      const terminate = (): void => {
        signalProcessGroup(child, "SIGTERM");
        terminationTimer ??= setTimeout(() => {
          terminationTimer = undefined;
          signalProcessGroup(child, "SIGKILL");
        }, this.limits.terminationGraceMs);
        terminationTimer.unref();
      };
      const fail = (error: HostCommandExecutionError): void => {
        if (failure !== undefined || settled) return;
        failure = error;
        terminate();
      };
      const active: ActiveCommand = { child, done, fail };
      this.#active.add(active);

      const abort = (): void => fail(new HostCommandExecutionError("host_command_aborted"));
      options.signal?.addEventListener("abort", abort, { once: true });

      const timeout = setTimeout(
        () => fail(new HostCommandExecutionError("host_command_timeout")),
        validated.timeoutMs,
      );
      timeout.unref();

      const append = (
        destination: Buffer[],
        chunk: Buffer,
        callback: ((value: Buffer) => void) | undefined,
      ): void => {
        if (failure !== undefined || settled) return;
        const remaining = validated.maxOutputBytes - outputBytes;
        if (chunk.byteLength > remaining) {
          if (remaining > 0) {
            const bounded = Buffer.from(chunk.subarray(0, remaining));
            destination.push(bounded);
            outputBytes += bounded.byteLength;
            invokeCallback(callback, bounded, fail);
          }
          fail(new HostCommandExecutionError("host_command_output_limit_exceeded"));
          return;
        }
        const copy = Buffer.from(chunk);
        destination.push(copy);
        outputBytes += copy.byteLength;
        invokeCallback(callback, copy, fail);
      };

      child.stdout?.on("data", (chunk: Buffer) => append(stdout, chunk, options.onStdout));
      child.stderr?.on("data", (chunk: Buffer) => append(stderr, chunk, options.onStderr));
      child.stdin?.on("error", () => undefined);
      child.once("error", (cause) => {
        fail(new HostCommandExecutionError("host_command_process_failed", { cause }));
      });
      child.once("close", (exitCode, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        if (terminationTimer !== undefined) clearTimeout(terminationTimer);
        options.signal?.removeEventListener("abort", abort);
        this.#active.delete(active);
        // A direct command may exit while leaving children behind in its process group.
        signalProcessGroup(child, "SIGKILL");
        finishDone();
        if (failure !== undefined) {
          reject(failure);
          return;
        }
        resolve({
          exitCode,
          signal,
          stdout: Buffer.concat(stdout),
          stderr: Buffer.concat(stderr),
        });
      });

      child.stdin?.end(validated.stdin);
    });
  }

  public async close(): Promise<void> {
    if (this.#closed && this.#active.size === 0) return;
    this.#closed = true;
    const active = [...this.#active];
    for (const command of active) {
      command.fail(new HostCommandExecutionError("host_command_closed"));
    }
    await Promise.allSettled(active.map((command) => command.done));
  }
}

function validateRequest(request: HostCommandRequest, limits: ResolvedLimits): ValidatedRequest {
  if (
    typeof request !== "object" ||
    request === null ||
    !Array.isArray(request.argv) ||
    request.argv.length === 0
  ) {
    throw new HostCommandExecutionError("host_command_invalid_request");
  }
  let argumentBytes = 0;
  for (const argument of request.argv) {
    if (typeof argument !== "string" || hasNul(argument)) {
      throw new HostCommandExecutionError("host_command_invalid_request");
    }
    argumentBytes += Buffer.byteLength(argument) + 1;
  }
  if (!path.isAbsolute(request.argv[0]) || argumentBytes > limits.maximumArgumentBytes) {
    throw new HostCommandExecutionError("host_command_invalid_request");
  }

  if (
    request.stdin !== undefined &&
    typeof request.stdin !== "string" &&
    !(request.stdin instanceof Uint8Array)
  ) {
    throw new HostCommandExecutionError("host_command_invalid_request");
  }
  const stdin =
    typeof request.stdin === "string"
      ? Buffer.from(request.stdin)
      : Buffer.from(request.stdin ?? []);
  if (stdin.byteLength > limits.maximumInputBytes) {
    throw new HostCommandExecutionError("host_command_input_too_large");
  }

  const timeoutMs = request.timeoutMs ?? limits.defaultTimeoutMs;
  const maxOutputBytes = request.maxOutputBytes ?? limits.defaultOutputBytes;
  if (
    !positiveSafeInteger(timeoutMs) ||
    timeoutMs > limits.maximumTimeoutMs ||
    !positiveSafeInteger(maxOutputBytes) ||
    maxOutputBytes > limits.maximumOutputBytes
  ) {
    throw new HostCommandExecutionError("host_command_invalid_request");
  }
  return { argv: request.argv, stdin, timeoutMs, maxOutputBytes };
}

function resolveLimits(options: CreateHostCommandExecutorOptions): ResolvedLimits {
  const limits: ResolvedLimits = {
    defaultTimeoutMs: options.limits?.defaultTimeoutMs ?? DEFAULT_HOST_COMMAND_TIMEOUT_MS,
    maximumTimeoutMs: options.limits?.maximumTimeoutMs ?? DEFAULT_MAXIMUM_TIMEOUT_MS,
    defaultOutputBytes:
      options.limits?.defaultOutputBytes ?? DEFAULT_HOST_COMMAND_OUTPUT_LIMIT_BYTES,
    maximumOutputBytes: options.limits?.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES,
    maximumInputBytes: options.limits?.maximumInputBytes ?? DEFAULT_MAXIMUM_INPUT_BYTES,
    maximumArgumentBytes: options.limits?.maximumArgumentBytes ?? DEFAULT_MAXIMUM_ARGUMENT_BYTES,
    terminationGraceMs: options.limits?.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
  };
  const values = [
    limits.defaultTimeoutMs,
    limits.maximumTimeoutMs,
    limits.defaultOutputBytes,
    limits.maximumOutputBytes,
    limits.maximumInputBytes,
    limits.maximumArgumentBytes,
    limits.terminationGraceMs,
  ];
  if (values.some((value) => !positiveSafeInteger(value))) {
    throw new HostCommandExecutionError("host_command_start_failed", {
      cause: new Error("host_command_limits_invalid"),
    });
  }
  if (
    limits.defaultTimeoutMs > limits.maximumTimeoutMs ||
    limits.defaultOutputBytes > limits.maximumOutputBytes
  ) {
    throw new HostCommandExecutionError("host_command_start_failed", {
      cause: new Error("host_command_limits_invalid"),
    });
  }
  return limits;
}

function inheritedHostEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined && !entry[0].startsWith("PI_SANDBOX_"),
    ),
  );
}

function invokeCallback(
  callback: ((chunk: Buffer) => void) | undefined,
  chunk: Buffer,
  fail: (error: HostCommandExecutionError) => void,
): void {
  try {
    callback?.(chunk);
  } catch (cause) {
    fail(new HostCommandExecutionError("host_command_process_failed", { cause }));
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    child.kill(signal);
    return;
  }
  try {
    process.kill(-child.pid, signal);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") child.kill(signal);
  }
}

function positiveSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function hasNul(value: string): boolean {
  return value.includes("\0");
}
