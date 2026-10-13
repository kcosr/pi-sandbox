import { spawn } from "node:child_process";
import { waitForSandboxCommand } from "../command-completion.js";
import {
  SandboxExecutionError,
  type SandboxCommandResult,
  type SandboxExecutionOptions,
} from "../contracts.js";

export interface SeatbeltProcess {
  readonly result: Promise<SandboxCommandResult>;
  abort(error: SandboxExecutionError): void;
}

/** Private pipes and an explicit environment; process-group cleanup is deliberately best effort. */
export function startSeatbeltProcess(
  executable: string,
  argv: readonly string[],
  environment: Readonly<Record<string, string>>,
  stdin: Buffer,
  timeoutMs: number,
  maxOutputBytes: number,
  options: Pick<SandboxExecutionOptions, "onStdout" | "onStderr"> = {},
): SeatbeltProcess {
  const child = spawn(executable, [...argv], {
    cwd: "/",
    env: environment,
    detached: true,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const stdout: Buffer[] = [],
    stderr: Buffer[] = [];
  let outputBytes = 0;
  let failure: SandboxExecutionError | undefined;
  let exited = false;
  let finished = false;

  const killGroup = (): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH")
        failure ??= new SandboxExecutionError("sandbox_process_failed", { cause });
    }
  };
  const abort = (error: SandboxExecutionError): void => {
    if (finished) return;
    failure ??= error;
    // Once reaped, its process-group ID may be reused. Never signal after
    // observing the direct child's exit, including during draining or late
    // abort. The active-child check is best effort, not an atomic PID lease.
    if (!exited) killGroup();
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  };
  child.once("spawn", () => {
    if (failure && !exited) killGroup();
  });
  child.once("exit", () => {
    exited = true;
    child.stdin.destroy();
  });
  child.stdin.on("error", (cause: NodeJS.ErrnoException) => {
    // A command may finish without consuming its entire bounded input.
    if (cause.code !== "EPIPE" && cause.code !== "ERR_STREAM_DESTROYED")
      abort(new SandboxExecutionError("sandbox_process_failed", { cause }));
  });
  const onStreamError = (cause: Error) =>
    abort(new SandboxExecutionError("sandbox_process_failed", { cause }));
  child.stdout.on("error", onStreamError);
  child.stderr.on("error", onStreamError);
  const timeout = setTimeout(() => abort(new SandboxExecutionError("sandbox_timeout")), timeoutMs);
  // Shared completion matches Pi's 100ms idle drain, restarted by either stream.
  // The ordinary job deadline and byte ceiling also bound late descendant output.
  const result = waitForSandboxCommand(child)
    .then(
      (exit) => {
        if (failure) throw failure;
        return { ...exit, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) };
      },
      (cause: unknown) => {
        throw failure ?? new SandboxExecutionError("sandbox_process_failed", { cause });
      },
    )
    .finally(() => {
      finished = true;
      clearTimeout(timeout);
    });
  const append = (destination: Buffer[], chunk: Buffer, callback?: (chunk: Buffer) => void) => {
    if (failure || finished) return;
    const remaining = maxOutputBytes - outputBytes;
    const bounded = Buffer.from(chunk.subarray(0, remaining));
    if (bounded.length) {
      destination.push(bounded);
      outputBytes += bounded.length;
      try {
        callback?.(Buffer.from(bounded));
      } catch (cause) {
        abort(new SandboxExecutionError("sandbox_process_failed", { cause }));
      }
    }
    if (chunk.length > remaining) abort(new SandboxExecutionError("sandbox_output_limit_exceeded"));
  };
  child.stdout.on("data", (chunk: Buffer) => append(stdout, chunk, options.onStdout));
  child.stderr.on("data", (chunk: Buffer) => append(stderr, chunk, options.onStderr));
  child.stdin.end(stdin);
  return { result, abort };
}
