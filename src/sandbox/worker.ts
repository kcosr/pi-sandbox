import { spawn, type ChildProcess } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";

import type { SandboxExecutionErrorCode } from "./contracts.js";
import { waitForSandboxCommand, type CommandExit } from "./command-completion.js";
import {
  encodeWorkerFrame,
  isWorkerRequest,
  MAXIMUM_WORKER_REQUEST_FRAME_BYTES,
  SANDBOX_WORKER_PROTOCOL_VERSION,
  WorkerFrameDecoder,
  type WorkerExecuteRequest,
  type WorkerFailureResponse,
  type WorkerRequest,
  type WorkerResponse,
} from "./worker-protocol.js";

const TERMINATE_GRACE_MS = 750;

interface QueuedExecution {
  readonly request: WorkerExecuteRequest;
  cancelled: boolean;
}

interface ActiveExecution extends QueuedExecution {
  child: ChildProcess | undefined;
  failure: WorkerFailureResponse | undefined;
  forceKillTimer: NodeJS.Timeout | undefined;
}

export async function runSandboxWorker(): Promise<void> {
  const worker = new SandboxWorker();
  await worker.run();
}

class SandboxWorker {
  readonly #decoder = new WorkerFrameDecoder(MAXIMUM_WORKER_REQUEST_FRAME_BYTES);
  readonly #queue: QueuedExecution[] = [];
  readonly #ids = new Set<number>();
  #active: ActiveExecution | undefined;
  #draining = false;
  #shuttingDown = false;
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
    if (this.#shuttingDown) return;
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
    if (this.#ids.has(request.id)) {
      this.fatal(new Error("sandbox_worker_request_id_reused"));
      return;
    }
    if (!path.isAbsolute(request.argv[0] ?? "")) {
      void this.sendFailure(request.id, "sandbox_invalid_request");
      return;
    }
    this.#ids.add(request.id);
    this.#queue.push({ request, cancelled: false });
    void this.drain().catch((cause: unknown) => this.fatal(cause));
  }

  private cancel(id: number): void {
    if (this.#active?.request.id === id) {
      this.failActive("sandbox_aborted");
      return;
    }
    const queued = this.#queue.find((execution) => execution.request.id === id);
    if (queued === undefined || queued.cancelled) return;
    queued.cancelled = true;
    this.#ids.delete(id);
    void this.sendFailure(id, "sandbox_aborted");
  }

  private async drain(): Promise<void> {
    if (this.#draining || this.#shuttingDown) return;
    this.#draining = true;
    try {
      while (!this.#shuttingDown) {
        const queued = this.#queue.shift();
        if (queued === undefined) break;
        if (queued.cancelled) continue;
        await this.execute(queued);
      }
    } finally {
      this.#draining = false;
      if (this.#shuttingDown && this.#active === undefined) await this.finishShutdown();
    }
  }

  private async execute(queued: QueuedExecution): Promise<void> {
    const active: ActiveExecution = {
      ...queued,
      child: undefined,
      failure: undefined,
      forceKillTimer: undefined,
    };
    this.#active = active;
    let timeout: NodeJS.Timeout | undefined;
    try {
      const stdin = decodeBase64(queued.request.stdin);
      const [executable, ...args] = queued.request.argv;
      if (executable === undefined) throw new Error("sandbox_worker_argv_empty");
      const child = spawn(executable, args, {
        cwd: process.cwd(),
        detached: true,
        env: process.env,
        stdio: ["pipe", "pipe", "pipe"],
      });
      active.child = child;
      let exitCleanup = Promise.resolve();
      let acceptingOutput = true;
      let outputBytes = 0;
      const output = (type: "stdout" | "stderr", value: Buffer | string) => {
        if (!acceptingOutput || active.failure !== undefined) return;
        const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
        outputBytes += chunk.byteLength;
        if (outputBytes > queued.request.maxOutputBytes) {
          this.failActive("sandbox_output_limit_exceeded");
          return;
        }
        void this.send({
          type,
          id: queued.request.id,
          data: chunk.toString("base64"),
        });
      };
      const stdout = (chunk: Buffer) => output("stdout", chunk);
      const stderr = (chunk: Buffer) => output("stderr", chunk);
      child.stdout?.on("data", stdout);
      child.stderr?.on("data", stderr);
      child.once("error", (cause) => {
        active.failure ??= failure(queued.request.id, "sandbox_process_failed", cause);
      });
      child.once("exit", () => {
        if (queued.request.processLifetime === "command" || active.failure !== undefined) {
          exitCleanup = this.killOtherSandboxProcesses();
        }
        void exitCleanup.catch(() => undefined);
      });
      timeout = setTimeout(() => this.failActive("sandbox_timeout"), queued.request.timeoutMs);
      timeout.unref();
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(stdin);
      let result: CommandExit;
      try {
        result = await (queued.request.processLifetime === "sandbox"
          ? waitForSandboxCommand(child)
          : new Promise<CommandExit>((resolve) => {
              child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
            }));
      } finally {
        // No old request may emit frames or trigger failActive after the next
        // command starts. All frames already queued precede the terminal frame.
        acceptingOutput = false;
        child.stdout?.removeListener("data", stdout);
        child.stderr?.removeListener("data", stderr);
      }
      await exitCleanup;
      if (queued.request.processLifetime === "command" || active.failure !== undefined) {
        await this.killOtherSandboxProcesses();
      }
      if (active.failure !== undefined) await this.send(active.failure);
      else await this.send({ type: "result", id: queued.request.id, ...result });
    } catch (cause) {
      await this.killOtherSandboxProcesses();
      await this.send(failure(queued.request.id, "sandbox_process_failed", cause));
    } finally {
      // A cancel may arrive while the terminal frame is being flushed. Do not
      // clear its escalation timer without completing namespace cleanup first.
      if (queued.request.processLifetime === "sandbox" && active.failure !== undefined) {
        await this.killOtherSandboxProcesses();
      }
      if (timeout !== undefined) clearTimeout(timeout);
      if (active.forceKillTimer !== undefined) clearTimeout(active.forceKillTimer);
      this.#ids.delete(queued.request.id);
      this.#active = undefined;
    }
  }

  private failActive(code: SandboxExecutionErrorCode): void {
    const active = this.#active;
    if (active === undefined || active.failure !== undefined) return;
    active.failure = { type: "failure", id: active.request.id, code };
    const child = active.child;
    if (child?.pid !== undefined) signalProcessGroup(child.pid, "SIGTERM");
    active.forceKillTimer = setTimeout(() => {
      void this.killOtherSandboxProcesses().catch((cause: unknown) => this.fatal(cause));
    }, TERMINATE_GRACE_MS);
    active.forceKillTimer.unref();
  }

  private shutdown(): void {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    for (const queued of this.#queue.splice(0)) {
      if (queued.cancelled) continue;
      queued.cancelled = true;
      this.#ids.delete(queued.request.id);
      void this.sendFailure(queued.request.id, "sandbox_closed");
    }
    if (this.#active !== undefined) this.failActive("sandbox_closed");
    else void this.finishShutdown().catch((cause: unknown) => this.fatal(cause));
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

  private sendFailure(id: number, code: SandboxExecutionErrorCode, cause?: unknown): Promise<void> {
    return this.send(failure(id, code, cause));
  }

  private send(response: WorkerResponse): Promise<void> {
    const frame = encodeWorkerFrame(response);
    this.#writeChain = this.#writeChain.then(
      () =>
        new Promise<void>((resolve, reject) => {
          process.stdout.write(frame, (cause) => (cause ? reject(cause) : resolve()));
        }),
    );
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
