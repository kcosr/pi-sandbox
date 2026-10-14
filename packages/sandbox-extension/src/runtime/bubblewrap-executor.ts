import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, constants as fsConstants, openSync } from "node:fs";
import { access, lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Writable } from "node:stream";

import type { NetworkMode } from "./contracts.js";
import {
  validateCommandRequest,
  resolveSandboxLimits,
  type ResolvedSandboxLimits,
} from "./command-limits.js";
import {
  BUBBLEWRAP_SECCOMP_FD,
  BUBBLEWRAP_STATUS_FD,
  assertSandboxCwd,
  buildBubblewrapArguments,
  planHiddenPaths,
  type HiddenPathMask,
} from "./bubblewrap-policy.js";
import {
  SandboxExecutionError,
  type CreateBubblewrapExecutorOptions,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxExecutionOptions,
  type SandboxExecutor,
  type ToolBundle,
  type ToolCommandPaths,
} from "./contracts.js";
import { resolveDirectToolCommands } from "./direct-executor.js";
import { assertToolBundlePlacement, snapshotToolBundle } from "./tool-bundle.js";
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
import { WORKER_TRANSPORT_IDLE_TIMEOUT_MS, WorkerFrameWriter } from "./worker-transport.js";

const STATUS_OUTPUT_LIMIT_BYTES = 65_536;
const WORKER_DIAGNOSTIC_LIMIT_BYTES = 65_536;
const WORKER_START_TIMEOUT_MS = 10_000;
const TERMINATE_GRACE_MS = 750;

interface ValidatedRequest {
  readonly argv: readonly [string, ...string[]];
  readonly stdin: Buffer;
  readonly timeoutMs: number | undefined;
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
  state: "queued" | "writing" | "sent" | "started";
  outputBytes: number;
  failure: SandboxExecutionError | undefined;
  completionTimeout: NodeJS.Timeout | undefined;
}

export async function createBubblewrapExecutor(
  options: CreateBubblewrapExecutorOptions,
): Promise<SandboxExecutor> {
  let toolBundle: ToolBundle | undefined;
  let limits: ResolvedSandboxLimits;
  try {
    toolBundle = snapshotToolBundle(options.toolBundle);
    limits = resolveSandboxLimits(options.limits);
    if (Object.hasOwn(options, "processLifetime"))
      throw new Error("sandbox_process_lifetime_removed");
  } catch (cause) {
    throw new SandboxExecutionError("sandbox_start_failed", { cause });
  }
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
  const hiddenPaths = Object.freeze([...(options.hiddenPaths ?? [])]);
  const hiddenMasks: HiddenPathMask[] = [];
  const commands = await resolveDirectToolCommands("linux", toolBundle);
  try {
    assertToolBundlePlacement(toolBundle, cwd, options.cwdWritable ?? true, hiddenPaths);
    const plan = planHiddenPaths(cwd, hiddenPaths);
    const effectivePaths = new Set([...plan.beforeCwd, ...plan.afterCwd]);
    for (const target of hiddenPaths) {
      const mask = await inspectHiddenPath(target);
      if (mask !== undefined && effectivePaths.has(target)) hiddenMasks.push(mask);
    }
    // Validate before allocating lifecycle state so an invalid policy cannot
    // leave close() waiting for a worker that was never spawned.
    buildBubblewrapArguments(
      cwd,
      workerCommand,
      options.networkMode ?? "none",
      environment,
      options.cwdWritable ?? true,
      hiddenMasks,
      toolBundle,
    );
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
    limits,
    seccompFilter,
    options.networkMode ?? "none",
    environment,
    options.cwdWritable ?? true,
    Object.freeze(hiddenMasks),
    commands,
    toolBundle,
  );
  try {
    await executor.start(workerCommand);
    return executor;
  } catch (cause) {
    await executor.close().catch(() => undefined);
    throw cause;
  }
}

async function inspectHiddenPath(target: string): Promise<HiddenPathMask | undefined> {
  let candidate = target;
  for (;;) {
    let candidateStat;
    try {
      candidateStat = await lstat(candidate);
    } catch (cause) {
      if (
        typeof cause !== "object" ||
        cause === null ||
        !("code" in cause) ||
        cause.code !== "ENOENT"
      ) {
        throw cause;
      }
      // ENOENT can mean a dangling ancestor symlink. Check the nearest existing
      // prefix before treating a target as absent; no host placeholders are made.
      const parent = path.dirname(candidate);
      if (parent === candidate) throw cause;
      candidate = parent;
      continue;
    }
    if (candidateStat.isSymbolicLink() || (await realpath(candidate)) !== candidate) {
      throw new Error("sandbox_hidden_path_not_canonical");
    }
    if (candidate !== target) {
      if (!candidateStat.isDirectory()) throw new Error("sandbox_hidden_path_parent_not_directory");
      return undefined;
    }
    if (!candidateStat.isDirectory() && !candidateStat.isFile()) {
      throw new Error("sandbox_hidden_path_not_file_or_directory");
    }
    return Object.freeze({ target, kind: candidateStat.isFile() ? "file" : "directory" });
  }
}

class PersistentBubblewrapExecutor implements SandboxExecutor {
  public readonly home = "/run/pi-sandbox/home";
  readonly #decoder = new WorkerFrameDecoder(MAXIMUM_WORKER_RESPONSE_FRAME_BYTES);
  readonly #pending = new Map<number, PendingExecution>();
  readonly #status: Buffer[] = [];
  readonly #diagnostics: Buffer[] = [];
  readonly #finished: Promise<void>;
  readonly #finish: () => void;
  #child: ChildProcess | undefined;
  #stdin: Writable | undefined;
  #writer: WorkerFrameWriter | undefined;
  #leaderExited = false;
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
    private readonly limits: ResolvedSandboxLimits,
    private readonly seccompFilter: Buffer,
    private readonly networkMode: NetworkMode,
    private readonly environment: Readonly<Record<string, string>>,
    private readonly cwdWritable: boolean,
    private readonly hiddenMasks: readonly HiddenPathMask[],
    public readonly commands: ToolCommandPaths,
    private readonly toolBundle: ToolBundle | undefined,
  ) {
    let finish!: () => void;
    this.#finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    this.#finish = finish;
  }

  public async start(workerCommand: readonly [string, ...string[]]): Promise<void> {
    if (this.#child !== undefined) throw new SandboxExecutionError("sandbox_start_failed");
    const fileMaskCount = this.hiddenMasks.filter(({ kind }) => kind === "file").length;
    const fileMaskInputs: number[] = [];
    let emptyInput: number | undefined;
    let child: ChildProcess;
    try {
      if (fileMaskCount > 0) {
        // Bun does not reliably deliver EOF when an extra JS pipe is ended
        // without data. Inherit actual read-only EOF descriptors instead.
        emptyInput = openSync("/dev/null", fsConstants.O_RDONLY);
        for (let index = 0; index < fileMaskCount; index++) fileMaskInputs.push(emptyInput);
      }
      child = spawn(
        this.bubblewrapPath,
        buildBubblewrapArguments(
          this.cwd,
          workerCommand,
          this.networkMode,
          this.environment,
          this.cwdWritable,
          this.hiddenMasks,
          this.toolBundle,
        ),
        {
          cwd: this.cwd,
          detached: true,
          env: {},
          stdio: ["pipe", "pipe", "pipe", "pipe", "pipe", ...fileMaskInputs],
        },
      );
      this.#child = child;
    } catch (cause) {
      throw new SandboxExecutionError("sandbox_start_failed", { cause });
    } finally {
      if (emptyInput !== undefined) closeSync(emptyInput);
    }
    this.#stdin = child.stdin ?? undefined;
    if (this.#stdin !== undefined) this.#writer = new WorkerFrameWriter(this.#stdin);
    child.once("exit", () => {
      this.#leaderExited = true;
    });

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
    for (const executable of Object.values(this.commands)) {
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
          this.commands.sh,
          "-c",
          'for executable do if ! test -x "$executable"; then printf "Required sandbox executable is unavailable: %s\\n" "$executable" >&2; exit 69; fi; done',
          "pi-sandbox-probe",
          ...Object.values(this.commands),
        ],
        timeoutMs: Math.min(10_000, this.limits.maximumTimeoutMs ?? 10_000),
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
    const writer = this.#writer;
    if (this.#closed || !this.#started || this.#settled || writer === undefined) {
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
        state: "queued",
        outputBytes: 0,
        failure: undefined,
        completionTimeout: undefined,
      };
      this.#pending.set(id, pending);
      options.signal?.addEventListener("abort", abort, { once: true });
      // Resolve and encode only when this whole frame reaches the transport.
      // Cancellation while queued removes the request without launching it.
      void writer
        .enqueue(() => {
          if (this.#pending.get(id) !== pending) return undefined;
          pending.state = "writing";
          return encodeWorkerFrame({
            type: "execute",
            id,
            argv: validated.argv,
            stdin: validated.stdin.toString("base64"),
            ...(validated.timeoutMs === undefined ? {} : { timeoutMs: validated.timeoutMs }),
            maxOutputBytes: validated.maxOutputBytes,
          });
        })
        .then(() => {
          if (this.#pending.get(id) !== pending || pending.state !== "writing") return;
          pending.state = "sent";
          this.armResponseTimeout(pending, "sandbox_worker_command_start_timeout");
        })
        .catch((cause: unknown) => this.workerFailed(cause));
    });
  }

  public async close(): Promise<void> {
    if (!this.#closed) {
      this.#closed = true;
      for (const pending of this.#pending.values()) {
        this.failPending(pending.id, new SandboxExecutionError("sandbox_closed"));
      }
      if (this.#child === undefined) {
        this.#settled = true;
        this.#finish();
      } else if (!this.#settled) {
        await this.send({ type: "shutdown" }).catch(() => undefined);
        const child = this.#child;
        const timer = setTimeout(() => {
          if (!this.#leaderExited) signalProcessGroup(child, "SIGKILL");
        }, TERMINATE_GRACE_MS);
        timer.unref();
        await this.#finished;
        clearTimeout(timer);
      }
    }
    await this.#finished;
  }

  private receiveWorkerData(chunk: Buffer): void {
    if (chunk.byteLength > 0) {
      for (const pending of this.#pending.values()) pending.completionTimeout?.refresh();
    }
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
    if (response.type === "started") {
      if (pending.state === "started" || pending.state === "queued") {
        this.workerFailed(new Error("sandbox_worker_started_invalid"));
        return;
      }
      pending.state = "started";
      // The worker's clock began at spawn, not at this delayed observation.
      if (pending.failure === undefined) this.clearResponseTimeout(pending);
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
    // Worker completion is final; no acceptance round-trip may restart or
    // retroactively expire the execution clock. An in-flight local abort still
    // rejects this request, while a late worker cancel is harmless by identity.
    const error = pending.failure;
    this.settlePending(pending, () => {
      if (error !== undefined) pending.reject(error);
      else
        pending.resolve({
          exitCode: response.exitCode,
          signal: response.signal,
          stdout: Buffer.concat(pending.stdout),
          stderr: Buffer.concat(pending.stderr),
        });
    });
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
    if (pending.state === "queued") {
      this.settlePending(pending, () => pending.reject(error));
      return;
    }
    this.clearResponseTimeout(pending);
    void this.send({ type: "cancel", id })
      .then(() => {
        if (this.#pending.get(id) === pending)
          this.armResponseTimeout(pending, "sandbox_worker_cancel_timeout");
      })
      .catch((cause: unknown) => this.workerFailed(cause));
  }

  private settlePending(pending: PendingExecution, settle: () => void): void {
    this.clearResponseTimeout(pending);
    pending.options.signal?.removeEventListener("abort", pending.abort);
    this.#pending.delete(pending.id);
    settle();
  }

  private clearResponseTimeout(pending: PendingExecution): void {
    if (pending.completionTimeout !== undefined) clearTimeout(pending.completionTimeout);
    pending.completionTimeout = undefined;
  }

  private armResponseTimeout(pending: PendingExecution, reason: string): void {
    this.clearResponseTimeout(pending);
    pending.completionTimeout = setTimeout(
      () => this.workerFailed(new Error(reason)),
      WORKER_TRANSPORT_IDLE_TIMEOUT_MS,
    );
    pending.completionTimeout.unref();
  }

  private send(request: WorkerRequest): Promise<void> {
    if (this.#writer === undefined || this.#settled)
      return Promise.reject(new SandboxExecutionError("sandbox_closed"));
    return this.#writer.enqueue(() => encodeWorkerFrame(request), true);
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
    this.#writer?.fail(error);
    this.clearStartupTimer();
    this.#startupReject?.(error);
    this.#startupReject = undefined;
    this.#startupResolve = undefined;
    for (const pending of [...this.#pending.values()]) {
      this.settlePending(pending, () => pending.reject(pending.failure ?? error));
    }
    if (this.#child !== undefined && !this.#leaderExited)
      signalProcessGroup(this.#child, "SIGKILL");
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
    this.#writer?.fail(this.#fatalError ?? new SandboxExecutionError("sandbox_closed"));
    this.#finish();
  }

  private clearStartupTimer(): void {
    if (this.#startupTimer !== undefined) clearTimeout(this.#startupTimer);
    this.#startupTimer = undefined;
  }
}

function validateRequest(
  request: SandboxCommandRequest,
  limits: ResolvedSandboxLimits,
): ValidatedRequest {
  if (request.cwd !== undefined || request.environment !== undefined) {
    throw new SandboxExecutionError("sandbox_invalid_request");
  }
  return validateCommandRequest(request, limits);
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
