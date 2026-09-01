import { spawn, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

import {
  BUBBLEWRAP_SECCOMP_FD,
  BUBBLEWRAP_STATUS_FD,
  assertSandboxCwd,
  buildBubblewrapArguments,
} from "./bubblewrap-policy.js";
import {
  DEFAULT_SANDBOX_OUTPUT_LIMIT_BYTES,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  SandboxExecutionError,
  type CreateBubblewrapExecutorOptions,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxExecutionOptions,
  type SandboxExecutor,
  type ToolCommandPaths,
} from "./contracts.js";
import { buildSandboxSeccompFilter } from "./seccomp-boundary-filter.js";
import {
  encodeWorkerFrame,
  INTERNAL_SANDBOX_WORKER_ARGUMENT,
  isWorkerResponse,
  MAXIMUM_WORKER_RESPONSE_FRAME_BYTES,
  SANDBOX_WORKER_PROTOCOL_VERSION,
  WorkerFrameDecoder,
  type WorkerRequest,
  type WorkerResponse,
} from "./worker-protocol.js";

const DEFAULT_MAXIMUM_TIMEOUT_MS = 600_000;
const DEFAULT_MAXIMUM_OUTPUT_BYTES = 64 * 1_048_576;
const DEFAULT_MAXIMUM_INPUT_BYTES = 64 * 1_048_576;
const DEFAULT_MAXIMUM_ARGUMENT_BYTES = 1_048_576;
const STATUS_OUTPUT_LIMIT_BYTES = 65_536;
const WORKER_DIAGNOSTIC_LIMIT_BYTES = 65_536;
const WORKER_START_TIMEOUT_MS = 10_000;
const TERMINATE_GRACE_MS = 750;

export const LINUX_TOOL_COMMANDS: ToolCommandPaths = Object.freeze({
  bash: "/bin/bash",
  sh: "/bin/sh",
  cat: "/bin/cat",
  chmod: "/bin/chmod",
  mkdir: "/bin/mkdir",
  mv: "/bin/mv",
  rm: "/bin/rm",
  grep: "/bin/grep",
  file: "/usr/bin/file",
  find: "/usr/bin/find",
  awk: "/usr/bin/awk",
  head: "/usr/bin/head",
  sha256sum: "/usr/bin/sha256sum",
  sort: "/usr/bin/sort",
  tail: "/usr/bin/tail",
  test: "/usr/bin/test",
  wc: "/usr/bin/wc",
});

export const REQUIRED_SANDBOX_EXECUTABLES = Object.freeze(Object.values(LINUX_TOOL_COMMANDS));

interface ResolvedLimits {
  readonly defaultTimeoutMs: number;
  readonly maximumTimeoutMs: number;
  readonly defaultOutputBytes: number;
  readonly maximumOutputBytes: number;
  readonly maximumInputBytes: number;
  readonly maximumArgumentBytes: number;
}

interface ValidatedRequest {
  readonly argv: readonly [string, ...string[]];
  readonly stdin: Buffer;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

interface PendingExecution {
  readonly id: number;
  readonly request: ValidatedRequest;
  readonly options: SandboxExecutionOptions;
  readonly stdout: Buffer[];
  readonly stderr: Buffer[];
  readonly resolve: (result: SandboxCommandResult) => void;
  readonly reject: (error: SandboxExecutionError) => void;
  readonly abort: () => void;
  timeout: NodeJS.Timeout;
  outputBytes: number;
  failure: SandboxExecutionError | undefined;
}

export async function createBubblewrapExecutor(
  options: CreateBubblewrapExecutorOptions,
): Promise<SandboxExecutor> {
  const cwd = path.normalize(options.cwd);
  assertSandboxCwd(cwd);
  const canonicalCwd = await realpath(cwd).catch((cause: unknown) => {
    throw new SandboxExecutionError("sandbox_start_failed", { cause });
  });
  if (canonicalCwd !== cwd) {
    throw new SandboxExecutionError("sandbox_start_failed", {
      cause: new Error("sandbox_cwd_not_canonical"),
    });
  }
  const cwdStat = await stat(cwd).catch((cause: unknown) => {
    throw new SandboxExecutionError("sandbox_start_failed", { cause });
  });
  if (!cwdStat.isDirectory()) {
    throw new SandboxExecutionError("sandbox_start_failed", {
      cause: new Error("sandbox_cwd_not_directory"),
    });
  }

  const configuredBwrap = options.bubblewrapPath;
  if (!path.isAbsolute(configuredBwrap)) {
    throw new SandboxExecutionError("sandbox_start_failed", {
      cause: new Error("sandbox_bwrap_not_absolute"),
    });
  }
  const bubblewrapPath = await realpath(configuredBwrap).catch((cause: unknown) => {
    throw new SandboxExecutionError("sandbox_start_failed", { cause });
  });
  await access(bubblewrapPath, fsConstants.X_OK).catch((cause: unknown) => {
    throw new SandboxExecutionError("sandbox_start_failed", { cause });
  });

  const workerCommand = options.workerCommand ?? [
    process.execPath,
    INTERNAL_SANDBOX_WORKER_ARGUMENT,
  ];
  validateWorkerCommand(workerCommand);
  const environment = Object.freeze({ ...(options.environment ?? {}) });
  try {
    // Validate before allocating lifecycle state so an invalid policy cannot
    // leave close() waiting for a worker that was never spawned.
    buildBubblewrapArguments(cwd, workerCommand, options.networkMode ?? "none", environment);
  } catch (cause) {
    throw new SandboxExecutionError("sandbox_start_failed", { cause });
  }
  let seccompFilter: Buffer;
  try {
    seccompFilter = buildSandboxSeccompFilter(process.arch, options.networkMode);
  } catch (cause) {
    throw new SandboxExecutionError("sandbox_start_failed", { cause });
  }

  const executor = new PersistentBubblewrapExecutor(
    cwd,
    bubblewrapPath,
    resolveLimits(options),
    seccompFilter,
    options.networkMode ?? "none",
    environment,
  );
  try {
    await executor.start(workerCommand);
    return executor;
  } catch (cause) {
    await executor.close().catch(() => undefined);
    throw cause;
  }
}

class PersistentBubblewrapExecutor implements SandboxExecutor {
  public readonly backend = "bubblewrap" as const;
  public readonly commands = LINUX_TOOL_COMMANDS;
  public readonly home = "/run/pi-sandbox/home";
  readonly #decoder = new WorkerFrameDecoder(MAXIMUM_WORKER_RESPONSE_FRAME_BYTES);
  readonly #pending = new Map<number, PendingExecution>();
  readonly #status: Buffer[] = [];
  readonly #diagnostics: Buffer[] = [];
  readonly #finished: Promise<void>;
  readonly #finish: () => void;
  #child: ChildProcess | undefined;
  #stdin: Writable | undefined;
  #writeChain = Promise.resolve();
  #nextRequestId = 1;
  #statusBytes = 0;
  #diagnosticBytes = 0;
  #sandboxStarted = false;
  #workerReady = false;
  #started = false;
  #closed = false;
  #settled = false;
  #fatalError: SandboxExecutionError | undefined;
  #startupTimer: NodeJS.Timeout | undefined;
  #startupResolve: (() => void) | undefined;
  #startupReject: ((error: SandboxExecutionError) => void) | undefined;

  public constructor(
    readonly cwd: string,
    readonly bubblewrapPath: string,
    private readonly limits: ResolvedLimits,
    private readonly seccompFilter: Buffer,
    private readonly networkMode: "none" | "host",
    private readonly environment: Readonly<Record<string, string>>,
  ) {
    let finish!: () => void;
    this.#finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.#finish = finish;
  }

  public async start(workerCommand: readonly [string, ...string[]]): Promise<void> {
    if (this.#child !== undefined) throw new SandboxExecutionError("sandbox_start_failed");
    const child = spawn(
      this.bubblewrapPath,
      buildBubblewrapArguments(this.cwd, workerCommand, this.networkMode, this.environment),
      {
        cwd: this.cwd,
        detached: true,
        env: {},
        stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
      },
    );
    this.#child = child;
    this.#stdin = child.stdin ?? undefined;

    child.stdout?.on("data", (chunk: Buffer) => this.receiveWorkerData(chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.appendDiagnostic(chunk));
    const statusStream = child.stdio[BUBBLEWRAP_STATUS_FD];
    if (statusStream && "on" in statusStream) {
      statusStream.on("data", (value: Buffer | string) => this.receiveStatusData(value));
    }
    const seccompStream = child.stdio[BUBBLEWRAP_SECCOMP_FD];
    if (!seccompStream || !("end" in seccompStream)) {
      throw new SandboxExecutionError("sandbox_start_failed");
    }
    seccompStream.on("error", (cause: Error) => this.workerFailed(cause));
    seccompStream.end(this.seccompFilter);
    child.once("error", (cause) => this.workerFailed(cause));
    child.once("close", (exitCode, signal) => this.workerClosed(exitCode, signal));

    await new Promise<void>((resolve, reject) => {
      this.#startupResolve = resolve;
      this.#startupReject = reject;
      this.#startupTimer = setTimeout(
        () => this.workerFailed(new Error("sandbox_worker_start_timeout")),
        WORKER_START_TIMEOUT_MS,
      );
      this.#startupTimer.unref();
      this.maybeResolveStartup();
    });
    this.#started = true;
  }

  public async probe(signal?: AbortSignal): Promise<void> {
    for (const executable of REQUIRED_SANDBOX_EXECUTABLES) {
      await access(executable, fsConstants.X_OK).catch((cause: unknown) => {
        throw new SandboxExecutionError("sandbox_start_failed", {
          cause: new Error(`Required sandbox executable is unavailable: ${executable}`, {
            cause,
          }),
        });
      });
    }
    const result = await this.execute(
      {
        argv: [
          "/bin/sh",
          "-c",
          'for executable do if ! test -x "$executable"; then printf "Required sandbox executable is unavailable: %s\\n" "$executable" >&2; exit 69; fi; done',
          "pi-sandbox-probe",
          ...REQUIRED_SANDBOX_EXECUTABLES,
        ],
        timeoutMs: 10_000,
        maxOutputBytes: 16_384,
      },
      signal ? { signal } : {},
    );
    if (result.exitCode !== 0) {
      const stderr = result.stderr.toString("utf8").trim();
      const outcome =
        result.exitCode === null
          ? `terminated by ${result.signal ?? "an unknown signal"}`
          : `exited with code ${String(result.exitCode)}`;
      throw new SandboxExecutionError("sandbox_start_failed", {
        cause: new Error(stderr.length > 0 ? stderr : `Sandbox prerequisite probe ${outcome}`),
      });
    }
  }

  public execute(
    request: SandboxCommandRequest,
    options: SandboxExecutionOptions = {},
  ): Promise<SandboxCommandResult> {
    if (this.#fatalError !== undefined) {
      return Promise.reject(this.#fatalError);
    }
    if (this.#closed || !this.#started || this.#settled) {
      return Promise.reject(new SandboxExecutionError("sandbox_closed"));
    }
    let validated: ValidatedRequest;
    try {
      validated = validateRequest(request, this.limits);
    } catch (cause) {
      return Promise.reject(
        cause instanceof SandboxExecutionError
          ? cause
          : new SandboxExecutionError("sandbox_invalid_request", { cause }),
      );
    }
    if (options.signal?.aborted) {
      return Promise.reject(new SandboxExecutionError("sandbox_aborted"));
    }

    const id = this.#nextRequestId++;
    return new Promise<SandboxCommandResult>((resolve, reject) => {
      const abort = () => this.failPending(id, new SandboxExecutionError("sandbox_aborted"));
      const pending: PendingExecution = {
        id,
        request: validated,
        options,
        stdout: [],
        stderr: [],
        resolve,
        reject,
        abort,
        timeout: setTimeout(
          () => this.failPending(id, new SandboxExecutionError("sandbox_timeout")),
          validated.timeoutMs,
        ),
        outputBytes: 0,
        failure: undefined,
      };
      pending.timeout.unref();
      this.#pending.set(id, pending);
      options.signal?.addEventListener("abort", abort, { once: true });
      void this.send({
        type: "execute",
        id,
        argv: validated.argv,
        stdin: validated.stdin.toString("base64"),
        timeoutMs: validated.timeoutMs,
        maxOutputBytes: validated.maxOutputBytes,
      }).catch((cause: unknown) => this.workerFailed(cause));
    });
  }

  public async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const pending of this.#pending.values()) {
        this.failPending(pending.id, new SandboxExecutionError("sandbox_closed"));
      }
      if (this.#child !== undefined && !this.#settled) {
        await this.send({ type: "shutdown" }).catch(() => undefined);
        const child = this.#child;
        const timer = setTimeout(() => signalProcessGroup(child, "SIGKILL"), TERMINATE_GRACE_MS);
        timer.unref();
        await this.#finished;
        clearTimeout(timer);
      }
    }
    await this.#finished;
  }

  private receiveWorkerData(chunk: Buffer): void {
    let responses: unknown[];
    try {
      responses = this.#decoder.push(chunk);
    } catch (cause) {
      this.workerFailed(cause);
      return;
    }
    for (const response of responses) {
      if (!isWorkerResponse(response)) {
        this.workerFailed(new Error("sandbox_worker_response_invalid"));
        return;
      }
      this.handleWorkerResponse(response);
    }
  }

  private handleWorkerResponse(response: WorkerResponse): void {
    if (response.type === "ready") {
      if (this.#workerReady || response.protocolVersion !== SANDBOX_WORKER_PROTOCOL_VERSION) {
        this.workerFailed(new Error("sandbox_worker_protocol_mismatch"));
        return;
      }
      this.#workerReady = true;
      this.maybeResolveStartup();
      return;
    }
    if (!this.#workerReady) {
      this.workerFailed(new Error("sandbox_worker_not_ready"));
      return;
    }
    const pending = this.#pending.get(response.id);
    if (pending === undefined) {
      this.workerFailed(new Error("sandbox_worker_response_id_unknown"));
      return;
    }
    if (response.type === "stdout" || response.type === "stderr") {
      this.appendOutput(pending, response.type, response.data);
      return;
    }
    if (response.type === "failure") {
      const error =
        pending.failure ??
        new SandboxExecutionError(response.code, {
          ...(response.message === undefined ? {} : { cause: new Error(response.message) }),
        });
      this.settlePending(pending, () => pending.reject(error));
      return;
    }
    if (response.type !== "result") {
      this.workerFailed(new Error("sandbox_worker_response_invalid"));
      return;
    }
    const signal = response.signal;
    const pendingFailure = pending.failure;
    if (pendingFailure !== undefined) {
      this.settlePending(pending, () => pending.reject(pendingFailure));
    } else {
      this.settlePending(pending, () =>
        pending.resolve({
          exitCode: response.exitCode,
          signal,
          stdout: Buffer.concat(pending.stdout),
          stderr: Buffer.concat(pending.stderr),
        }),
      );
    }
  }

  private appendOutput(
    pending: PendingExecution,
    stream: "stdout" | "stderr",
    encoded: string,
  ): void {
    if (pending.failure !== undefined) return;
    let chunk: Buffer;
    try {
      chunk = decodeBase64(encoded);
    } catch (cause) {
      this.workerFailed(cause);
      return;
    }
    pending.outputBytes += chunk.byteLength;
    if (pending.outputBytes > pending.request.maxOutputBytes) {
      this.failPending(pending.id, new SandboxExecutionError("sandbox_output_limit_exceeded"));
      return;
    }
    const destination = stream === "stdout" ? pending.stdout : pending.stderr;
    destination.push(chunk);
    const callback = stream === "stdout" ? pending.options.onStdout : pending.options.onStderr;
    if (callback !== undefined) {
      try {
        callback(Buffer.from(chunk));
      } catch (cause) {
        this.failPending(
          pending.id,
          new SandboxExecutionError("sandbox_process_failed", { cause }),
        );
      }
    }
  }

  private failPending(id: number, error: SandboxExecutionError): void {
    const pending = this.#pending.get(id);
    if (pending === undefined || pending.failure !== undefined) return;
    pending.failure = error;
    void this.send({ type: "cancel", id }).catch((cause: unknown) => this.workerFailed(cause));
  }

  private settlePending(pending: PendingExecution, settle: () => void): void {
    clearTimeout(pending.timeout);
    pending.options.signal?.removeEventListener("abort", pending.abort);
    this.#pending.delete(pending.id);
    settle();
  }

  private send(request: WorkerRequest): Promise<void> {
    const stdin = this.#stdin;
    if (stdin === undefined || this.#settled) {
      return Promise.reject(new SandboxExecutionError("sandbox_closed"));
    }
    const frame = encodeWorkerFrame(request);
    this.#writeChain = this.#writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          stdin.write(frame, (cause) => (cause ? reject(cause) : resolve()));
        }),
    );
    return this.#writeChain;
  }

  private receiveStatusData(value: Buffer | string): void {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    this.#statusBytes += chunk.byteLength;
    if (this.#statusBytes > STATUS_OUTPUT_LIMIT_BYTES) {
      this.workerFailed(new Error("sandbox_worker_status_too_large"));
      return;
    }
    this.#status.push(chunk);
    this.#sandboxStarted = statusShowsSandboxStarted(Buffer.concat(this.#status));
    this.maybeResolveStartup();
  }

  private appendDiagnostic(value: Buffer | string): void {
    if (this.#diagnosticBytes >= WORKER_DIAGNOSTIC_LIMIT_BYTES) return;
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const remaining = WORKER_DIAGNOSTIC_LIMIT_BYTES - this.#diagnosticBytes;
    const bounded = chunk.subarray(0, remaining);
    this.#diagnostics.push(Buffer.from(bounded));
    this.#diagnosticBytes += bounded.byteLength;
  }

  private maybeResolveStartup(): void {
    if (!this.#sandboxStarted || !this.#workerReady || this.#startupResolve === undefined) return;
    const resolve = this.#startupResolve;
    this.clearStartupTimer();
    this.#startupResolve = undefined;
    this.#startupReject = undefined;
    resolve();
  }

  private workerFailed(cause: unknown): void {
    if (this.#settled || this.#fatalError !== undefined) return;
    const code = this.#started ? "sandbox_process_failed" : "sandbox_start_failed";
    const diagnostic = Buffer.concat(this.#diagnostics).toString("utf8").trim();
    const error = new SandboxExecutionError(code, {
      cause: diagnostic.length > 0 ? new Error(diagnostic, { cause }) : cause,
    });
    this.#fatalError = error;
    this.clearStartupTimer();
    this.#startupReject?.(error);
    this.#startupReject = undefined;
    this.#startupResolve = undefined;
    for (const pending of [...this.#pending.values()]) {
      this.settlePending(pending, () => pending.reject(pending.failure ?? error));
    }
    if (this.#child !== undefined) signalProcessGroup(this.#child, "SIGKILL");
  }

  private workerClosed(exitCode: number | null, signal: NodeJS.Signals | null): void {
    if (this.#settled) return;
    try {
      this.#decoder.finish();
    } catch (cause) {
      this.workerFailed(cause);
    }
    const expected = this.#closed && (exitCode === 0 || signal === "SIGKILL");
    if (!expected) {
      this.workerFailed(
        new Error(
          `sandbox_worker_exited:${exitCode === null ? (signal ?? "unknown") : String(exitCode)}`,
        ),
      );
    }
    if (this.#startupReject !== undefined) {
      const error =
        this.#fatalError ??
        new SandboxExecutionError("sandbox_start_failed", {
          cause: new Error("sandbox_worker_closed_during_startup"),
        });
      this.clearStartupTimer();
      this.#startupReject(error);
      this.#startupReject = undefined;
      this.#startupResolve = undefined;
    }
    for (const pending of [...this.#pending.values()]) {
      const error =
        pending.failure ?? this.#fatalError ?? new SandboxExecutionError("sandbox_process_failed");
      this.settlePending(pending, () => pending.reject(error));
    }
    this.#settled = true;
    this.#finish();
  }

  private clearStartupTimer(): void {
    if (this.#startupTimer !== undefined) clearTimeout(this.#startupTimer);
    this.#startupTimer = undefined;
  }
}

function validateRequest(request: SandboxCommandRequest, limits: ResolvedLimits): ValidatedRequest {
  if (!Array.isArray(request.argv) || request.argv.length === 0) {
    throw new SandboxExecutionError("sandbox_invalid_request");
  }
  let argumentBytes = 0;
  for (const argument of request.argv) {
    if (typeof argument !== "string" || argument.includes("\0")) {
      throw new SandboxExecutionError("sandbox_invalid_request");
    }
    argumentBytes += Buffer.byteLength(argument) + 1;
  }
  if (!path.isAbsolute(request.argv[0]) || argumentBytes > limits.maximumArgumentBytes) {
    throw new SandboxExecutionError("sandbox_invalid_request");
  }
  const stdin =
    typeof request.stdin === "string"
      ? Buffer.from(request.stdin)
      : Buffer.from(request.stdin ?? new Uint8Array());
  if (stdin.byteLength > limits.maximumInputBytes) {
    throw new SandboxExecutionError("sandbox_input_too_large");
  }
  const timeoutMs = request.timeoutMs ?? limits.defaultTimeoutMs;
  const maxOutputBytes = request.maxOutputBytes ?? limits.defaultOutputBytes;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0 ||
    timeoutMs > limits.maximumTimeoutMs ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    maxOutputBytes > limits.maximumOutputBytes
  ) {
    throw new SandboxExecutionError("sandbox_invalid_request");
  }
  return { argv: request.argv, stdin, timeoutMs, maxOutputBytes };
}

function resolveLimits(options: CreateBubblewrapExecutorOptions): ResolvedLimits {
  const limits: ResolvedLimits = {
    defaultTimeoutMs: options.limits?.defaultTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
    maximumTimeoutMs: options.limits?.maximumTimeoutMs ?? DEFAULT_MAXIMUM_TIMEOUT_MS,
    defaultOutputBytes: options.limits?.defaultOutputBytes ?? DEFAULT_SANDBOX_OUTPUT_LIMIT_BYTES,
    maximumOutputBytes: options.limits?.maximumOutputBytes ?? DEFAULT_MAXIMUM_OUTPUT_BYTES,
    maximumInputBytes: options.limits?.maximumInputBytes ?? DEFAULT_MAXIMUM_INPUT_BYTES,
    maximumArgumentBytes: options.limits?.maximumArgumentBytes ?? DEFAULT_MAXIMUM_ARGUMENT_BYTES,
  };
  const values = Object.values(limits);
  if (values.some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new SandboxExecutionError("sandbox_start_failed", {
      cause: new Error("sandbox_limits_invalid"),
    });
  }
  if (
    limits.defaultTimeoutMs > limits.maximumTimeoutMs ||
    limits.defaultOutputBytes > limits.maximumOutputBytes
  ) {
    throw new SandboxExecutionError("sandbox_start_failed", {
      cause: new Error("sandbox_limits_invalid"),
    });
  }
  return limits;
}

function validateWorkerCommand(
  command: readonly string[],
): asserts command is readonly [string, ...string[]] {
  if (
    command.length === 0 ||
    !path.isAbsolute(command[0] ?? "") ||
    command.some((argument) => typeof argument !== "string" || argument.includes("\0"))
  ) {
    throw new SandboxExecutionError("sandbox_start_failed", {
      cause: new Error("sandbox_worker_command_invalid"),
    });
  }
}

function signalProcessGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
  }
}

function statusShowsSandboxStarted(buffer: Buffer): boolean {
  for (const line of buffer.toString("utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const status = JSON.parse(line) as unknown;
      if (
        status !== null &&
        typeof status === "object" &&
        Number.isSafeInteger((status as Record<string, unknown>)["child-pid"])
      ) {
        return true;
      }
    } catch {
      return false;
    }
  }
  return false;
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("sandbox_worker_output_invalid");
  }
  return Buffer.from(value, "base64");
}
