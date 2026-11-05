import {
  SandboxExportError,
  type SandboxExportSource,
  type SandboxExportReader,
} from "./contracts.js";
import type { ExportOperation, ExportReply } from "./protocol.js";

export interface ExportConnection {
  request(operation: ExportOperation, signal?: AbortSignal): Promise<ExportReply>;
  close(): Promise<void>;
}

export function createExportSource(options: {
  readonly writableHostPaths: readonly string[];
  readonly connect: () => Promise<ExportConnection>;
}): SandboxExportSource {
  let active = false;
  return {
    writableHostPaths: Object.freeze([...options.writableHostPaths]),
    async open(signal) {
      if (active) throw new SandboxExportError("export_already_active");
      if (signal?.aborted) throw new SandboxExportError("export_aborted");
      active = true;
      const lifetime = new AbortController();
      const combinedSignal =
        signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]);
      let connection: ExportConnection | undefined;
      try {
        connection = await options.connect();
        const opened = await connection.request({ operation: "begin" }, combinedSignal);
        if (opened.operation !== "begin") throw new SandboxExportError("export_protocol_error");
        const connected = connection;
        let closed = false;
        let closing: Promise<void> | undefined;
        let pending: Promise<ExportReply> | undefined;
        const request = (operation: ExportOperation): Promise<ExportReply> => {
          if (closed) return Promise.reject(new SandboxExportError("export_closed"));
          if (pending !== undefined)
            return Promise.reject(new SandboxExportError("export_request_already_active"));
          const task = connected.request(operation, combinedSignal);
          pending = task;
          void task
            .finally(() => {
              if (pending === task) pending = undefined;
            })
            .catch(() => undefined);
          return task;
        };
        const reader: SandboxExportReader = {
          roots: Object.freeze(opened.roots.map((root) => Object.freeze({ ...root }))),
          async list(rootId, path, cursor) {
            const reply = await request({
              operation: "list",
              rootId,
              path,
              ...(cursor === undefined ? {} : { cursor }),
            });
            if (reply.operation !== "list") throw new SandboxExportError("export_protocol_error");
            return reply.page;
          },
          async openFile(entry) {
            await request({ operation: "open", entry });
          },
          async readChunk() {
            const reply = await request({ operation: "read" });
            if (reply.operation !== "read") throw new SandboxExportError("export_protocol_error");
            return Buffer.from(reply.data, "base64");
          },
          async closeFile() {
            await request({ operation: "closeFile" });
          },
          close() {
            if (closing !== undefined) return closing;
            closed = true;
            lifetime.abort();
            return (closing = (async () => {
              try {
                await pending?.catch(() => undefined);
                await connected.request({ operation: "end" });
              } finally {
                try {
                  await connected.close();
                } finally {
                  active = false;
                }
              }
            })());
          },
        };
        return reader;
      } catch (error) {
        lifetime.abort();
        await connection?.request({ operation: "end" }).catch(() => undefined);
        await connection?.close().catch(() => undefined);
        active = false;
        throw error;
      }
    },
  };
}
