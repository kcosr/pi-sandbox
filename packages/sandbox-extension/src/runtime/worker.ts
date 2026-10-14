import { readdir } from "node:fs/promises";
import path from "node:path";

import { SandboxExecutionError, type SandboxExecutionErrorCode } from "./contracts.js";
import { startSandboxProcess } from "./command-process.js";
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
import { WorkerFrameWriter } from "./worker-transport.js";

interface Execution {
  readonly process: ReturnType<typeof startSandboxProcess>;
  readonly task: Promise<void>;
}

export async function runSandboxWorker(): Promise<void> {
  const worker = new SandboxWorker();
  await worker.run();
}

class SandboxWorker {
  readonly #decoder = new WorkerFrameDecoder(MAXIMUM_WORKER_REQUEST_FRAME_BYTES);
  readonly #writer = new WorkerFrameWriter(process.stdout);
  readonly #executions = new Map<number, Execution>();
  #lastRequestId = 0;
  #shuttingDown = false;
  #failed = false;

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
      // A result may already be in transit. Its ID is never reused, and a late
      // cancellation cannot affect another execution or a reaped process group.
      this.#executions.get(request.id)?.process.abort(new SandboxExecutionError("sandbox_aborted"));
      return;
    }
    if (request.id <= this.#lastRequestId) {
      this.fatal(new Error("sandbox_worker_request_id_reused"));
      return;
    }
    this.#lastRequestId = request.id;
    if (this.#shuttingDown || !path.isAbsolute(request.argv[0] ?? "")) {
      void this.send(
        failure(request.id, this.#shuttingDown ? "sandbox_closed" : "sandbox_invalid_request"),
      );
      return;
    }
    this.execute(request);
  }

  private execute(request: WorkerExecuteRequest): void {
    try {
      const [executable, ...argv] = request.argv;
      if (executable === undefined) throw new Error("sandbox_worker_argv_empty");
      const running = startSandboxProcess({
        executable,
        argv,
        cwd: process.cwd(),
        environment: process.env,
        stdin: decodeBase64(request.stdin),
        timeoutMs: request.timeoutMs,
        maxOutputBytes: request.maxOutputBytes,
        captureOutput: false,
        onStarted: () => this.send({ type: "started", id: request.id }),
        onStdout: (chunk) => this.sendOutput("stdout", request.id, chunk),
        onStderr: (chunk) => this.sendOutput("stderr", request.id, chunk),
      });
      const task = running.result
        .then(
          ({ exitCode, signal }) => this.send({ type: "result", id: request.id, exitCode, signal }),
          (cause: unknown) =>
            this.send(
              failure(
                request.id,
                cause instanceof SandboxExecutionError ? cause.code : "sandbox_process_failed",
                cause,
              ),
            ),
        )
        .finally(() => this.#executions.delete(request.id));
      this.#executions.set(request.id, { process: running, task });
      void task.catch((cause: unknown) => this.fatal(cause));
    } catch (cause) {
      void this.send(failure(request.id, "sandbox_process_failed", cause));
    }
  }

  private shutdown(): void {
    if (this.#shuttingDown) return;
    this.#shuttingDown = true;
    const executions = [...this.#executions.values()];
    for (const execution of executions)
      execution.process.abort(new SandboxExecutionError("sandbox_closed"));
    void Promise.all(executions.map(({ task }) => task))
      .then(() => this.killOtherSandboxProcesses())
      .then(() => {
        process.exitCode = 0;
        process.stdin.pause();
      })
      .catch((cause: unknown) => this.fatal(cause));
  }

  /** The namespace-wide sweep is exclusively final shutdown/fatal recovery. */
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
    const sent = this.#writer.enqueue(() => encodeWorkerFrame(response));
    void sent.catch((cause: unknown) => this.fatal(cause));
    return sent;
  }

  private sendOutput(type: "stdout" | "stderr", id: number, chunk: Buffer): Promise<void> {
    const sent = this.#writer.enqueue(() =>
      encodeWorkerFrame({ type, id, data: chunk.toString("base64") }),
    );
    void sent.catch((cause: unknown) => this.fatal(cause));
    return sent;
  }

  private fatal(cause: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#shuttingDown = true;
    this.#writer.fail(cause);
    for (const execution of this.#executions.values())
      execution.process.abort(new SandboxExecutionError("sandbox_process_failed", { cause }));
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
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : undefined;
  return { type: "failure", id, code, ...(message === undefined ? {} : { message }) };
}

function decodeBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value))
    throw new Error("sandbox_worker_stdin_invalid");
  return Buffer.from(value, "base64");
}
