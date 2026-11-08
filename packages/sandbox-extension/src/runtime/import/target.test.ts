import { describe, expect, it } from "vitest";
import { createImportTarget, type ImportConnection } from "./target.js";
import { IMPORT_LIMITS } from "./contracts.js";
import type { ImportOperation, ImportReply } from "./protocol.js";

function reply(operation: ImportOperation): ImportReply {
  if (operation.operation === "finish") return { operation: "finish", path: "/proc/2/fd/9" };
  if (operation.operation === "reserveDirectory")
    return {
      operation: "reserveDirectory",
      directory: { path: "/proc/2/fd/10", displayPath: `/run/pi-sandbox/home/${operation.path}` },
    };
  return { operation: operation.operation };
}

describe("trusted import target", () => {
  it("snapshots binary chunks, rejects overlapping operations, and sequences close after pending writes", async () => {
    const requests: ImportOperation[] = [];
    let release: (() => void) | undefined;
    const connection: ImportConnection = {
      async request(operation) {
        requests.push(operation);
        if (operation.operation === "write")
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        return reply(operation);
      },
    };
    const session = await createImportTarget(connection).open();
    const bytes = Buffer.from("original");
    const writing = session.writeChunk(bytes);
    bytes.fill(0);
    await expect(session.finish()).rejects.toThrow("import_request_already_active");
    const closing = session.close();
    expect(requests.map((request) => request.operation)).toEqual(["begin", "write"]);
    release!();
    await writing;
    await closing;
    expect(requests.map((request) => request.operation)).toEqual(["begin", "write", "close"]);
    expect(requests[1]).toMatchObject({ data: Buffer.from("original").toString("base64") });
  });
  it("retains descriptor lifetime after cancellation until explicit close without affecting peers", async () => {
    const requests: ImportOperation[] = [];
    const target = createImportTarget({
      request(operation) {
        requests.push(operation);
        return Promise.resolve(reply(operation));
      },
    });
    const abort = new AbortController();
    const first = await target.open(abort.signal);
    const second = await target.open();
    abort.abort();
    await Promise.resolve();
    expect(requests.some((request) => request.operation === "close")).toBe(false);
    await first.close();
    await expect(first.writeChunk(Buffer.from("a"))).rejects.toThrow("import_aborted");
    await second.writeChunk(Buffer.from("b"));
    expect(await second.finish()).toBe("/proc/2/fd/9");
    await second.reserveDirectory("repos/b");
    await second.verifyDirectory();
    await second.close();
    expect(new Set(requests.map((request) => request.sessionId)).size).toBe(2);
  });
  it("enforces the cumulative transfer limit before sending excess bytes", async () => {
    let bytes = 0;
    const session = await createImportTarget({
      request(operation) {
        if (operation.operation === "write")
          bytes += Buffer.from(operation.data, "base64").byteLength;
        return Promise.resolve(reply(operation));
      },
    }).open();
    const chunk = Buffer.alloc(IMPORT_LIMITS.chunkBytes);
    for (let index = 0; index < IMPORT_LIMITS.maximumBytes / chunk.byteLength; index++)
      await session.writeChunk(chunk);
    expect(bytes).toBe(IMPORT_LIMITS.maximumBytes);
    await expect(session.writeChunk(Buffer.from([1]))).rejects.toThrow("import_size_limit");
    await session.close();
  }, 10_000);
  it("closes a failed or aborted opening using its known session ID", async () => {
    const requests: ImportOperation[] = [];
    const target = createImportTarget({
      request(operation) {
        requests.push(operation);
        if (operation.operation === "begin") return Promise.reject(new Error("opening failed"));
        return Promise.resolve(reply(operation));
      },
    });
    await expect(target.open()).rejects.toThrow("opening failed");
    expect(requests.map((request) => request.operation)).toEqual(["begin", "close"]);
    expect(requests[0]!.sessionId).toBe(requests[1]!.sessionId);
  });
});
