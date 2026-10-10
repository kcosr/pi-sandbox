import { spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

import type { SandboxExecutionErrorCode } from "./contracts.js";
import { waitForSandboxCommand, type CommandExit } from "./command-completion.js";
import {
  encodeWorkerFrame,
  isWorkerRequest,
  MAXIMUM_WORKER_REQUEST_FRAME_BYTES,
  MAXIMUM_WORKER_PENDING_COMMANDS,
  MAXIMUM_SANDBOX_ACTIVE_COMMANDS,
  SANDBOX_WORKER_PROTOCOL_VERSION,
  WorkerFrameDecoder,
  type WorkerExecuteRequest,
  type WorkerFailureResponse,
  type WorkerRequest,
  type WorkerResponse,
} from "./worker-protocol.js";
import { WORKER_TRANSPORT_IDLE_TIMEOUT_MS, writeWorkerFrame } from "./worker-transport.js";

const TERMINATE_GRACE_MS = 750;

type ExecutionState = "queued" | "running" | "offered" | "terminal";

interface Execution {
  readonly request: WorkerExecuteRequest;
  state: ExecutionState;
  child: ChildProcess | undefined;
  failure: WorkerFailureResponse | undefined;
  task: Promise<void>;
  timeout: NodeJS.Timeout | undefined;
  retirementTimeout: NodeJS.Timeout | undefined;
}

interface CleanupBarrier {
  readonly members: Set<number>;
  cleaned: boolean;
}

export async function runSandboxWorker(): Promise<void> {
  const worker = new SandboxWorker();
  await worker.run();
}

class SandboxWorker {
  readonly #decoder = new WorkerFrameDecoder(MAXIMUM_WORKER_REQUEST_FRAME_BYTES);
  readonly #queue: Execution[] = [];
  readonly #executions = new Map<number, Execution>();
  readonly #active = new Map<number, Execution>();
  #processLifetime: WorkerExecuteRequest["processLifetime"] | undefined;
  #lastRequestId = 0;
  #barrier: CleanupBarrier | undefined;
  #shuttingDown = false;
  #finishingShutdown = false;
  #failed = false;
  #writeChain = Promise.resolve();

  public async run(): Promise<void> {
    process.stdin.on("data", (chunk: Buffer) => this.receive(chunk));
    process.stdin.once("end", () => this.shutdown());
    process.stdin.once("error", (cause) => this.fatal(cause));
    process.stdout.once("error", (cause) => this.fatal(cause));
    await this.send({ type: "ready", protocolVersion: SANDBOX_WORKER_PROTOCOL_VERSION });
    await new Promise<void>((resolve) => process.once("beforeExit", () => resolve()));
  }

  private receive(chunk: Buffer): void {
    if (this.#failed) return;
    if (chunk.byteLength > 0) {
      for (const execution of this.#executions.values()) execution.retirementTimeout?.refresh();
    }
    let frames: unknown[];
    try {
      frames = this.#decoder.push(chunk);
    } catch (cause) {
      this.fatal(cause);
      return;
    }
    for (const frame of frames) {
      if (!isWorkerRequest(frame)) {
        this.fatal(new Error("sandbox_worker_request_invalid"));
        return;
      }
      this.handle(frame);
    }
  }

  private handle(request: WorkerRequest): void {
    if (request.type === "shutdown") {
      this.shutdown();
      return;
    }
    if (request.type === "cancel") {
      this.cancel(request.id);
      return;
    }
    if (request.type === "accept") {
      const execution = this.#executions.get(request.id);
      // A cleanup may overtake an offered result. Keep its identity until the
      // parent retires the failure, consuming any already-in-flight acceptance.
      if (execution?.failure !== undefined) return;
      if (execution?.state !== "offered") {
        this.fatal(new Error("sandbox_worker_accept_invalid"));
        return;
      }
      this.terminal(execution, { type: "completed", id: request.id });
      return;
    }
    if (request.type === "retire") {
      const execution = this.#executions.get(request.id);
      if (execution?.state !== "terminal") {
        this.fatal(new Error("sandbox_worker_retire_invalid"));
        return;
      }
      if (execution.retirementTimeout !== undefined) clearTimeout(execution.retirementTimeout);
      this.#executions.delete(request.id);
      this.#active.delete(request.id);
      this.#barrier?.members.delete(request.id);
      this.finishBarrier();
      this.drain();
      return;
    }
    if (request.id <= this.#lastRequestId) {
      this.fatal(new Error("sandbox_worker_request_id_reused"));
      return;
    }
    this.#lastRequestId = request.id;
    if (this.#executions.size >= MAXIMUM_WORKER_PENDING_COMMANDS) {
      // The parent applies this bound before allocating and writing a request.
      this.fatal(new Error("sandbox_worker_admission_limit_exceeded"));
      return;
    }
    if (this.#processLifetime !== undefined && this.#processLifetime !== request.processLifetime) {
      this.fatal(new Error("sandbox_worker_process_lifetime_changed"));
      return;
    }
    this.#processLifetime = request.processLifetime;
    const execution: Execution = {
      request,
      state: "queued",
      child: undefined,
      failure: undefined,
      task: Promise.resolve(),
      timeout: undefined,
      retirementTimeout: undefined,
    };
    this.#executions.set(request.id, execution);
    if (this.#shuttingDown || !path.isAbsolute(request.argv[0] ?? "")) {
      this.terminal(
        execution,
        failure(request.id, this.#shuttingDown ? "sandbox_closed" : "sandbox_invalid_request"),
      );
      return;
    }
    this.#queue.push(execution);
    this.drain();
  }

  private cancel(id: number): void {
    const execution = this.#executions.get(id);
    if (
      execution === undefined ||
      execution.state === "terminal" ||
      execution.failure !== undefined
    )
      return;
    if (execution.state === "queued") {
      this.#queue.splice(this.#queue.indexOf(execution), 1);
      this.terminal(execution, failure(id, "sandbox_aborted"));
      return;
    }
    this.failActive(execution, "sandbox_aborted");
  }

  private drain(): void {
    if (this.#shuttingDown) {
      this.maybeFinishShutdown();
      return;
    }
    if (this.#barrier !== undefined || this.#failed) return;
    const limit = this.#processLifetime === "sandbox" ? MAXIMUM_SANDBOX_ACTIVE_COMMANDS : 1;
    while (this.#active.size < limit && this.#barrier === undefined) {
      const execution = this.#queue.shift();
      if (execution === undefined) break;
      execution.state = "running";
      this.#active.set(execution.request.id, execution);
      execution.task = this.execute(execution);
      void execution.task.catch((cause: unknown) => this.fatal(cause));
    }
  }

  private async execute(execution: Execution): Promise<void> {
    const request = execution.request;
    try {
      const stdin = decodeBase64(request.stdin);
      const [executable, ...args] = request.argv;
      if (executable === undefined) throw new Error("sandbox_worker_argv_empty");
      const child = spawn(executable, args, {
        cwd: process.cwd(),
        detached: true,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      execution.child = child;
      let exitCleanup = Promise.resolve();
      let acceptingOutput = true;
      let outputBytes = 0;
      const output = (type: "stdout" | "stderr", value: Buffer | string) => {
        if (!acceptingOutput || execution.failure !== undefined) return;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        outputBytes += chunk.byteLength;
        if (outputBytes > request.maxOutputBytes) {
          this.failActive(execution, "sandbox_output_limit_exceeded");
          return;
        }
        void this.send({ type, id: request.id, data: chunk.toString("base64") });
      };
      const stdout = (chunk: Buffer) => output("stdout", chunk);
      const stderr = (chunk: Buffer) => output("stderr", chunk);
      child.stdout?.on("data", stdout);
      child.stderr?.on("data", stderr);
      child.once("error", (cause) => this.failActive(execution, "sandbox_process_failed", cause));
      child.once("exit", () => {
        if (request.processLifetime === "command" && execution.failure === undefined) {
          exitCleanup = this.killOtherSandboxProcesses();
          void exitCleanup.catch((cause: unknown) => this.fatal(cause));
        }
      });
      execution.timeout = setTimeout(
        () => this.failActive(execution, "sandbox_timeout"),
        request.timeoutMs,
      );
      execution.timeout.unref();
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin);
      let result: CommandExit;
      try {
        result = await (request.processLifetime === "sandbox"
          ? waitForSandboxCommand(child)
          : new Promise<CommandExit>((resolve) => {
              child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
            }));
      } finally {
        acceptingOutput = false;
        child.stdout?.removeListener("data", stdout);
        child.stderr?.removeListener("data", stderr);
      }
      await exitCleanup;
      if (execution.failure !== undefined) return;
      if (request.processLifetime === "command") {
        await this.killOtherSandboxProcesses();
        if (execution.failure === undefined)
          this.terminal(execution, { type: "result", id: request.id, ...result });
      } else {
        // The parent owns the final deadline decision. Keep this operation
        // active until acceptance, so a concurrent cleanup can still fail it.
        this.clearTimeout(execution);
        execution.state = "offered";
        await this.send({ type: "result", id: request.id, ...result });
      }
    } catch (cause) {
      this.failActive(execution, "sandbox_process_failed", cause);
    }
  }

  private failActive(execution: Execution, code: SandboxExecutionErrorCode, cause?: unknown): void {
    if (execution.failure !== undefined || execution.state === "terminal") return;
    const affected = [...this.#active.values()].filter((item) => item.state !== "terminal");
    const barrier: CleanupBarrier = {
      members: new Set(affected.map((item) => item.request.id)),
      cleaned: false,
    };
    // Freeze admission and mark every affected request before the first await.
    this.#barrier = barrier;
    for (const item of affected) {
      item.failure =
        item === execution
          ? failure(item.request.id, code, cause)
          : failure(
              item.request.id,
              code === "sandbox_closed" ? code : "sandbox_aborted",
              "Interrupted by sandbox-wide cleanup",
            );
      this.clearTimeout(item);
      if (item.child?.pid !== undefined) signalProcessGroup(item.child.pid, "SIGTERM");
    }
    // Defer to a microtask so execute() has assigned its task even when spawn or
    // input decoding failed synchronously.
    void Promise.resolve()
      .then(() => this.cleanup(barrier, affected))
      .catch((error: unknown) => this.fatal(error));
  }

  private async cleanup(barrier: CleanupBarrier, affected: readonly Execution[]): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const finished = Promise.all(affected.map((item) => item.task));
    try {
      await Promise.race([
        finished,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, TERMINATE_GRACE_MS);
        }),
      ]);
      await this.killOtherSandboxProcesses();
      await finished;
      for (const execution of affected) {
        if (execution.failure === undefined) throw new Error("sandbox_worker_cleanup_invalid");
        this.terminal(execution, execution.failure);
      }
      await this.#writeChain;
      barrier.cleaned = true;
      this.finishBarrier();
      this.drain();
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  private finishBarrier(): void {
    if (this.#barrier?.cleaned && this.#barrier.members.size === 0) this.#barrier = undefined;
  }

  private terminal(execution: Execution, response: WorkerResponse): void {
    this.clearTimeout(execution);
    execution.state = "terminal";
    void this.send(response)
      .then(() => {
        // The parent may retire before the write callback's continuation runs.
        if (this.#executions.get(execution.request.id) !== execution) return;
        execution.retirementTimeout = setTimeout(
          () => this.fatal(new Error("sandbox_worker_retirement_timeout")),
          WORKER_TRANSPORT_IDLE_TIMEOUT_MS,
        );
        execution.retirementTimeout.unref();
      })
      .catch((cause: unknown) => this.fatal(cause));
  }

  private clearTimeout(execution: Execution): void {
    if (execution.timeout !== undefined) clearTimeout(execution.timeout);
    execution.timeout = undefined;
  }

  private shutdown(): void {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    for (const execution of this.#queue.splice(0)) {
      this.terminal(execution, failure(execution.request.id, "sandbox_closed"));
    }
    const active = [...this.#active.values()].find(
      (execution) => execution.state !== "terminal" && execution.failure === undefined,
    );
    if (active !== undefined) this.failActive(active, "sandbox_closed");
    this.maybeFinishShutdown();
  }

  private maybeFinishShutdown(): void {
    if (
      !this.#shuttingDown ||
      this.#finishingShutdown ||
      this.#barrier !== undefined ||
      this.#active.size !== 0
    )
      return;
    this.#finishingShutdown = true;
    void this.finishShutdown().catch((cause: unknown) => this.fatal(cause));
  }

  private async finishShutdown(): Promise<void> {
    await this.killOtherSandboxProcesses();
    await this.#writeChain.catch(() => undefined);
    process.exitCode = 0;
    process.stdin.pause();
  }

  private async killOtherSandboxProcesses(): Promise<void> {
    const entries = await readdir("/proc");
    for (const entry of entries) {
      if (!/^\d+$/u.test(entry)) continue;
      const pid = Number(entry);
      if (pid <= 1 || pid === process.pid) continue;
      try {
        process.kill(pid, "SIGKILL");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
      }
    }
  }

  private send(response: WorkerResponse): Promise<void> {
    const frame = encodeWorkerFrame(response);
    this.#writeChain = this.#writeChain.then(() => writeWorkerFrame(process.stdout, frame));
    this.#writeChain.catch((cause: unknown) => this.fatal(cause));
    return this.#writeChain;
  }

  private fatal(cause: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#shuttingDown = true;
    process.stderr.write(
      `pi-sandbox-worker: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    );
    const finish = (): void => {
      process.exitCode = 70;
      process.stdin.pause();
    };
    void this.killOtherSandboxProcesses().then(finish, finish);
  }
}

function failure(
  id: number,
  code: SandboxExecutionErrorCode,
  cause?: unknown,
): WorkerFailureResponse {
  const message =
    cause instanceof Error
      ? cause.message
      : typeof cause === "string" || typeof cause === "number" || typeof cause === "boolean"
        ? String(cause)
        : undefined;
  return { type: "failure", id, code, ...(message === undefined ? {} : { message }) };
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error("sandbox_worker_stdin_invalid");
  }
  return Buffer.from(value, "base64");
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
  }
}
