import type { ChildProcess } from "node:child_process";
import {
  encodeWorkerFrame,
  isWorkerResponse,
  MAXIMUM_WORKER_RESPONSE_FRAME_BYTES,
  SANDBOX_WORKER_PROTOCOL_VERSION,
  WorkerFrameDecoder,
} from "../worker-protocol.js";
import { WorkerFrameWriter } from "../worker-transport.js";
import { SandboxExportError } from "./contracts.js";
import type { ExportConnection } from "./source.js";
import { isExportOperation, type ExportOperation, type ExportReply } from "./protocol.js";

/** Owns just this internal reader child. Never signals a process group or other tools. */
export async function connectExportReader(child: ChildProcess): Promise<ExportConnection> {
  if (!child.stdin || !child.stdout) throw new SandboxExportError("export_reader_start_failed");
  const writer = new WorkerFrameWriter(child.stdin);
  const decoder = new WorkerFrameDecoder(MAXIMUM_WORKER_RESPONSE_FRAME_BYTES);
  let ready = false;
  let closed = false;
  let exited = false;
  let failed = false;
  let nextId = 0;
  let settleReady!: { resolve: () => void; reject: (error: Error) => void };
  const started = new Promise<void>((resolve, reject) => {
    settleReady = { resolve, reject };
  });
  let settleFinished!: () => void;
  const finished = new Promise<void>((resolve) => {
    settleFinished = resolve;
  });
  let pending:
    | {
        id: number;
        operation: ExportOperation;
        resolve: (reply: ExportReply) => void;
        reject: (error: Error) => void;
        abort: () => void;
        signal: AbortSignal | undefined;
      }
    | undefined;
  const settle = (error?: Error, reply?: ExportReply) => {
    const request = pending;
    pending = undefined;
    request?.signal?.removeEventListener("abort", request.abort);
    if (error) request?.reject(error);
    else if (reply) request?.resolve(reply);
  };
  const fail = () => {
    if (failed) return;
    failed = true;
    const error = new SandboxExportError("export_reader_failed");
    writer.fail(error);
    settleReady.reject(error);
    settle(error);
    if (!exited) child.kill("SIGKILL");
  };
  const startupTimer = setTimeout(fail, 10_000);
  startupTimer.unref();
  child.stdin.on("error", fail);
  child.stdout.on("data", (chunk: Buffer) => {
    if (failed) return;
    try {
      for (const value of decoder.push(chunk)) {
        if (!isWorkerResponse(value)) throw new Error("export_reader_response_invalid");
        if (value.type === "ready") {
          if (ready || value.protocolVersion !== SANDBOX_WORKER_PROTOCOL_VERSION)
            throw new Error("export_reader_version_invalid");
          ready = true;
          clearTimeout(startupTimer);
          settleReady.resolve();
          continue;
        }
        if (!ready || !pending || value.id !== pending.id)
          throw new Error("export_reader_response_invalid");
        if (value.type === "export-failure") settle(new SandboxExportError(value.code));
        else if (
          value.type === "export-result" &&
          value.reply.operation === pending.operation.operation
        ) {
          if (pending.signal?.aborted) settle(new SandboxExportError("export_aborted"));
          else settle(undefined, value.reply);
        } else throw new Error("export_reader_response_invalid");
      }
    } catch {
      fail();
    }
  });
  child.stderr?.resume();
  child.once("error", fail);
  child.once("exit", () => {
    exited = true;
  });
  child.once("close", () => {
    exited = true;
    clearTimeout(startupTimer);
    try {
      decoder.finish();
    } catch {
      fail();
    }
    if (!closed) fail();
    settle(new SandboxExportError("export_closed"));
    settleFinished();
  });
  try {
    await started;
  } catch (error) {
    await finished;
    throw error;
  }
  return {
    request(operation, signal) {
      if (!isExportOperation(operation))
        return Promise.reject(new SandboxExportError("export_invalid_request"));
      if (closed || failed || exited)
        return Promise.reject(new SandboxExportError("export_closed"));
      if (pending) return Promise.reject(new SandboxExportError("export_request_already_active"));
      if (signal?.aborted) return Promise.reject(new SandboxExportError("export_aborted"));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const abort = () => {
          void writer.enqueue(() => encodeWorkerFrame({ type: "cancel", id }), true).catch(fail);
        };
        pending = { id, operation, resolve, reject, abort, signal };
        signal?.addEventListener("abort", abort, { once: true });
        void writer
          .enqueue(() => encodeWorkerFrame({ type: "export", id, request: operation }))
          .catch(fail);
      });
    },
    async close() {
      if (closed) return finished;
      closed = true;
      child.stdin?.end();
      const timer = setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
      }, 1500);
      timer.unref();
      await finished;
      clearTimeout(timer);
    },
  };
}
