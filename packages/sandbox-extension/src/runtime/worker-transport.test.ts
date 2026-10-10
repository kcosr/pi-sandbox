import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import { WORKER_TRANSPORT_IDLE_TIMEOUT_MS, writeWorkerFrame } from "./worker-transport.js";

describe("worker frame transport", () => {
  afterEach(() => vi.useRealTimers());

  it("preserves a large frame while bounding each individual write", async () => {
    const chunks: Buffer[] = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    });
    const frame = Buffer.alloc(200_003, 0xa7);
    await writeWorkerFrame(destination, frame);
    expect(chunks.map((chunk) => chunk.byteLength)).toEqual([65_536, 65_536, 65_536, 3_395]);
    expect(Buffer.concat(chunks)).toEqual(frame);
  });

  it("allows a progressing frame to exceed the inactivity interval in total", async () => {
    vi.useFakeTimers();
    let writes = 0;
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        writes++;
        setTimeout(callback, WORKER_TRANSPORT_IDLE_TIMEOUT_MS - 1_000);
      },
    });
    const completed = expect(
      writeWorkerFrame(destination, Buffer.alloc(3 * 65_536)),
    ).resolves.toBeUndefined();
    await vi.advanceTimersByTimeAsync(27_000);
    await completed;
    expect(writes).toBe(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a stalled write and never continues after its late callback", async () => {
    vi.useFakeTimers();
    const callbacks: Array<(error?: Error | null) => void> = [];
    const destination = new Writable({
      write(_chunk, _encoding, callback) {
        callbacks.push(callback);
      },
    });
    const failed = expect(writeWorkerFrame(destination, Buffer.alloc(2 * 65_536))).rejects.toThrow(
      "sandbox_worker_write_timeout",
    );
    await vi.advanceTimersByTimeAsync(WORKER_TRANSPORT_IDLE_TIMEOUT_MS);
    await failed;
    callbacks[0]?.();
    await vi.advanceTimersByTimeAsync(1);
    expect(callbacks).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the watchdog when the stream throws synchronously", async () => {
    vi.useFakeTimers();
    const destination = new Writable();
    destination.write = () => {
      throw new Error("write failed");
    };
    await expect(writeWorkerFrame(destination, Buffer.from("frame"))).rejects.toThrow(
      "write failed",
    );
    expect(vi.getTimerCount()).toBe(0);
  });
});
