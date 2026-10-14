import { spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { waitForSandboxCommand } from "./command-completion.js";
import { SandboxExecutionError, type SandboxCommandResult } from "./contracts.js";

export interface SandboxProcess {
  readonly result: Promise<SandboxCommandResult>;
  abort(error: SandboxExecutionError): void;
}

export interface SandboxProcessOptions {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly stdin: Buffer;
  readonly timeoutMs: number | undefined;
  readonly maxOutputBytes: number;
  readonly onStarted?: () => void | Promise<void>;
  readonly onStdout?: (chunk: Buffer) => void | Promise<void>;
  readonly onStderr?: (chunk: Buffer) => void | Promise<void>;
  /** A worker can forward output without retaining a second full copy. */
  readonly captureOutput?: boolean;
}

/** In-process command bookkeeping shared by confined and direct launchers. */
export function startSandboxProcess(options: SandboxProcessOptions): SandboxProcess {
  const child = spawn(options.executable, [...options.argv], {
    cwd: options.cwd,
    env: options.environment,
    detached: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  const callbacks = new Set<Promise<void>>();
  const drain = new AbortController();
  let failure: SandboxExecutionError | undefined;
  let launched = false,
    exited = false,
    finished = false,
    outputBytes = 0;
  let timeout: NodeJS.Timeout | undefined;
  let signallingFailed = false;

  const killGroup = () => {
    if (exited || signallingFailed || child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") {
        signallingFailed = true;
        failure = new SandboxExecutionError(failure?.code ?? "sandbox_process_failed", { cause });
        // Report uncertain termination instead of hanging close forever. The
        // process may survive within its original grants; no monitor is added.
        child.unref();
      }
    }
  };
  const abort = (error: SandboxExecutionError) => {
    if (finished) return;
    failure ??= error;
    // Node can return the child before its spawn event. Defer termination until
    // that event so a pre-launch cancellation cannot miss group creation or
    // consume the abort notification before a signalling failure is known.
    if (!launched && !exited) return;
    // This is best effort, not an atomic PID lease. Never signal after observing
    // the leader's exit, even when descendants keep its output pipes open.
    killGroup();
    drain.abort();
  };
  const failed = (cause: unknown) =>
    abort(new SandboxExecutionError("sandbox_process_failed", { cause }));
  const awaitCallback = (callback: Promise<void>, resume: () => void) => {
    const pending = callback.then(resume, failed).finally(() => callbacks.delete(pending));
    callbacks.add(pending);
  };
  child.once("spawn", () => {
    launched = true;
    if (failure) {
      abort(failure);
      return;
    }
    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(
        () => abort(new SandboxExecutionError("sandbox_timeout")),
        options.timeoutMs,
      );
      timeout.unref();
    }
    try {
      const started = options.onStarted?.();
      if (started) {
        child.stdout.pause();
        child.stderr.pause();
        awaitCallback(Promise.resolve(started), () => {
          if (!failure && !finished) {
            child.stdout.resume();
            child.stderr.resume();
          }
        });
      }
    } catch (cause) {
      failed(cause);
    }
  });
  child.once("exit", () => {
    exited = true;
    child.stdin.destroy();
  });
  child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
    if (cause.code !== "EPIPE" && cause.code !== "ERR_STREAM_DESTROYED") failed(cause);
  });
  child.stdout.on("error", failed);
  child.stderr.on("error", failed);
  child.once("error", failed);

  const append = (
    stream: Readable,
    destination: Buffer[],
    chunk: Buffer,
    callback?: (value: Buffer) => void | Promise<void>,
  ) => {
    if (failure || finished) return;
    const remaining = options.maxOutputBytes - outputBytes;
    const bounded = Buffer.from(chunk.subarray(0, remaining));
    if (bounded.length) {
      outputBytes += bounded.length;
      if (options.captureOutput !== false) destination.push(bounded);
      try {
        const output = callback?.(Buffer.from(bounded));
        if (output) {
          stream.pause();
          awaitCallback(Promise.resolve(output), () => {
            if (!failure && !finished) stream.resume();
          });
        }
      } catch (cause) {
        failed(cause);
      }
    }
    if (chunk.length > remaining) abort(new SandboxExecutionError("sandbox_output_limit_exceeded"));
  };
  child.stdout.on("data", (chunk: Buffer) => append(child.stdout, stdout, chunk, options.onStdout));
  child.stderr.on("data", (chunk: Buffer) => append(child.stderr, stderr, chunk, options.onStderr));
  const result = waitForSandboxCommand(child, {
    signal: drain.signal,
    isOutputPending: () => callbacks.size > 0,
    abandonOnAbort: () => signallingFailed,
  })
    .then(
      async (exit) => {
        // The process clock ends at completion, not after transport acknowledgments.
        if (timeout !== undefined) clearTimeout(timeout);
        if (!failure && callbacks.size > 0) {
          let stopWaiting!: () => void;
          const cancelled = new Promise<void>((resolve) => {
            stopWaiting = resolve;
          });
          drain.signal.addEventListener("abort", stopWaiting, { once: true });
          try {
            if (!drain.signal.aborted) await Promise.race([Promise.all([...callbacks]), cancelled]);
          } finally {
            drain.signal.removeEventListener("abort", stopWaiting);
          }
        }
        if (failure) throw failure;
        return { ...exit, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      },
      (cause: unknown) => {
        throw failure ?? new SandboxExecutionError("sandbox_process_failed", { cause });
      },
    )
    .finally(() => {
      finished = true;
      if (timeout !== undefined) clearTimeout(timeout);
    });
  child.stdin.end(options.stdin);
  return { result, abort };
}
