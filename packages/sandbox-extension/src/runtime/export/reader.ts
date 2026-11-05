import { ExportFileService } from "./files.js";
import { SandboxExportError } from "./contracts.js";
import { runExportOperation, type ExportReaderConfiguration } from "./protocol.js";
import {
  encodeWorkerFrame,
  isWorkerRequest,
  MAXIMUM_WORKER_REQUEST_FRAME_BYTES,
  SANDBOX_WORKER_PROTOCOL_VERSION,
  WorkerFrameDecoder,
} from "../worker-protocol.js";
import { WorkerFrameWriter } from "../worker-transport.js";

/** A confined read-only role. It has no execute handler and no process-group or namespace cleanup. */
export async function runSandboxExportReader(
  configuration: ExportReaderConfiguration,
): Promise<void> {
  const service = await ExportFileService.create("seatbelt", configuration.roots);
  const decoder = new WorkerFrameDecoder(MAXIMUM_WORKER_REQUEST_FRAME_BYTES);
  const writer = new WorkerFrameWriter(process.stdout);
  let active: Promise<void> | undefined;
  let activeId: number | undefined;
  let lastId = 0;
  let closed = false;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const close = (failed = false) => {
    if (closed) return;
    closed = true;
    service.cancel();
    process.stdin.pause();
    if (failed) {
      process.exitCode = 70;
      writer.fail(new Error("export_reader_protocol_error"));
    }
    void Promise.resolve(active)
      .catch(() => undefined)
      .then(() => service.close())
      .then(finish, () => {
        process.exitCode = 70;
        finish();
      });
  };
  process.stdin.on("data", (chunk: Buffer) => {
    if (closed) return;
    try {
      for (const value of decoder.push(chunk)) {
        if (!isWorkerRequest(value)) throw new Error("export_reader_request_invalid");
        if (value.type === "cancel") {
          if (activeId === value.id) service.cancel();
          continue;
        }
        if (value.type !== "export" || value.id <= lastId || active !== undefined)
          throw new Error("export_reader_request_invalid");
        lastId = value.id;
        activeId = value.id;
        const task = runExportOperation(service, value.request)
          .then(
            (reply) =>
              writer.enqueue(() =>
                encodeWorkerFrame({ type: "export-result", id: value.id, reply }),
              ),
            (error: unknown) =>
              writer.enqueue(() =>
                encodeWorkerFrame({
                  type: "export-failure",
                  id: value.id,
                  code:
                    error instanceof SandboxExportError ? error.code : "export_source_unavailable",
                }),
              ),
          )
          .finally(() => {
            active = undefined;
            activeId = undefined;
          });
        active = task;
        void task.catch(() => close(true));
      }
    } catch {
      close(true);
    }
  });
  process.stdin.once("end", () => {
    try {
      decoder.finish();
      close();
    } catch {
      close(true);
    }
  });
  process.stdin.once("error", () => close(true));
  process.stdout.once("error", () => close(true));
  try {
    await writer.enqueue(() =>
      encodeWorkerFrame({ type: "ready", protocolVersion: SANDBOX_WORKER_PROTOCOL_VERSION }),
    );
    await finished;
  } finally {
    await service.close();
  }
}
