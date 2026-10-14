import { Writable } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WORKER_TRANSPORT_IDLE_TIMEOUT_MS,
  WorkerFrameWriter,
  writeWorkerFrame,
} from "./worker-transport.js";

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
  it("encodes lazily and prioritizes controls only between complete ordered request frames", async () => {
    const encoded: string[] = [];
    const chunks: Buffer[] = [];
    const callbacks: Array<() => void> = [];
    const destination = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(Buffer.from(chunk));
        callbacks.push(callback);
      },
    });
    const writer = new WorkerFrameWriter(destination);
    const send = (label: string, size: number, control = false) =>
      writer.enqueue(() => {
        encoded.push(label);
        return Buffer.alloc(size, label.charCodeAt(0));
      }, control);
    const first = send("a", 65_537);
    const second = send("b", 1);
    const third = send("c", 1);
    const cancel = send("x", 1, true);
    const shutdown = send("y", 1, true);
    expect(encoded).toEqual(["a"]);
    for (let index = 0; index < 6; index++) {
      await vi.waitFor(() => expect(callbacks.length).toBeGreaterThan(index));
      callbacks[index]!();
    }
    await Promise.all([first, second, third, cancel, shutdown]);
    expect(encoded).toEqual(["a", "x", "y", "b", "c"]);
    expect(chunks.map((chunk) => [String.fromCharCode(chunk[0]!), chunk.length])).toEqual([
      ["a", 65_536],
      ["a", 1],
      ["x", 1],
      ["y", 1],
      ["b", 1],
      ["c", 1],
    ]);
  });

  it("can discard a queued request before encoding and rejects queued frames on transport failure", async () => {
    let callback: ((cause?: Error | null) => void) | undefined;
    const destination = new Writable({
      write(_chunk, _encoding, done) {
        callback = done;
      },
    });
    destination.on("error", () => undefined);
    const writer = new WorkerFrameWriter(destination);
    const active = writer.enqueue(() => Buffer.from("active"));
    let encoded = false;
    const queued = writer.enqueue(() => {
      encoded = true;
      return Buffer.from("queued");
    });
    const failed = Promise.all([
      expect(active).rejects.toThrow("broken"),
      expect(queued).rejects.toThrow("broken"),
    ]);
    callback!(new Error("broken"));
    await failed;
    expect(encoded).toBe(false);
    await expect(writer.enqueue(() => Buffer.from("late"))).rejects.toThrow("broken");
  });

  it("omits cancelled lazy frames without writing bytes", async () => {
    const chunks: Buffer[] = [];
    const writer = new WorkerFrameWriter(
      new Writable({
        write(chunk: Buffer, _encoding, callback) {
          chunks.push(chunk);
          callback();
        },
      }),
    );
    await writer.enqueue(() => undefined);
    await writer.enqueue(() => Buffer.from("next"));
    expect(Buffer.concat(chunks).toString()).toBe("next");
  });
});
