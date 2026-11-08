import { randomUUID } from "node:crypto";
import {
  assertImportPath,
  IMPORT_LIMITS,
  SandboxImportError,
  type SandboxImportSession,
  type SandboxImportTarget,
} from "./contracts.js";
import type { ImportOperation, ImportReply } from "./protocol.js";

export interface ImportConnection {
  request(operation: ImportOperation, signal?: AbortSignal): Promise<ImportReply>;
}

export function createImportTarget(connection: ImportConnection): SandboxImportTarget {
  return {
    async open(signal) {
      if (signal?.aborted) throw new SandboxImportError("import_aborted");
      const sessionId = randomUUID();
      const lifetime = new AbortController();
      const combined =
        signal === undefined ? lifetime.signal : AbortSignal.any([signal, lifetime.signal]);
      let pending: Promise<ImportReply> | undefined;
      let closing: Promise<void> | undefined;
      let finished = false;
      let reserved = false;
      let transferred = 0;
      const request = (operation: ImportOperation): Promise<ImportReply> => {
        if (combined.aborted) return Promise.reject(new SandboxImportError("import_aborted"));
        if (closing !== undefined) return Promise.reject(new SandboxImportError("import_closed"));
        if (pending !== undefined)
          return Promise.reject(new SandboxImportError("import_request_already_active"));
        const task = connection.request(operation, combined).then((reply) => {
          if (reply.operation !== operation.operation)
            throw new SandboxImportError("import_protocol_error");
          return reply;
        });
        pending = task;
        void task
          .finally(() => {
            if (pending === task) pending = undefined;
          })
          .catch(() => undefined);
        return task;
      };
      const close = (): Promise<void> => {
        if (closing !== undefined) return closing;
        lifetime.abort();
        closing = (async () => {
          await pending?.catch(() => undefined);
          const reply = await connection.request({ operation: "close", sessionId });
          if (reply.operation !== "close") throw new SandboxImportError("import_protocol_error");
        })();
        return closing;
      };
      try {
        await request({ operation: "begin", sessionId });
        if (combined.aborted) throw new SandboxImportError("import_aborted");
        const session: SandboxImportSession = {
          async writeChunk(bytes) {
            if (
              !(bytes instanceof Uint8Array) ||
              bytes.byteLength === 0 ||
              bytes.byteLength > IMPORT_LIMITS.chunkBytes
            )
              throw new SandboxImportError("import_invalid_chunk");
            if (finished) throw new SandboxImportError("import_finished");
            if (transferred + bytes.byteLength > IMPORT_LIMITS.maximumBytes)
              throw new SandboxImportError("import_size_limit");
            const snapshot = Buffer.from(bytes);
            await request({ operation: "write", sessionId, data: snapshot.toString("base64") });
            transferred += snapshot.byteLength;
          },
          async finish() {
            if (finished) throw new SandboxImportError("import_finished");
            const reply = await request({ operation: "finish", sessionId });
            if (reply.operation !== "finish") throw new SandboxImportError("import_protocol_error");
            finished = true;
            return reply.path;
          },
          async reserveDirectory(relativePath) {
            assertImportPath(relativePath);
            if (reserved) throw new SandboxImportError("import_directory_already_reserved");
            const reply = await request({
              operation: "reserveDirectory",
              sessionId,
              path: relativePath,
            });
            if (reply.operation !== "reserveDirectory")
              throw new SandboxImportError("import_protocol_error");
            reserved = true;
            return Object.freeze({ ...reply.directory });
          },
          async verifyDirectory() {
            if (!reserved) throw new SandboxImportError("import_directory_unavailable");
            await request({ operation: "verifyDirectory", sessionId });
          },
          close,
        };
        return session;
      } catch (error) {
        await close().catch(() => undefined);
        throw error;
      }
    },
  };
}
