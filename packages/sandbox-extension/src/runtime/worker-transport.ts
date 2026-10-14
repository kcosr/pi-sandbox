import type { Writable } from "node:stream";

export const WORKER_TRANSPORT_IDLE_TIMEOUT_MS = 10_000;
const WRITE_CHUNK_BYTES = 65_536;

/** Preserve whole-frame FIFO ordering while bounding each stalled pipe write. */
export async function writeWorkerFrame(destination: Writable, frame: Buffer): Promise<void> {
  for (let offset = 0; offset < frame.byteLength; offset += WRITE_CHUNK_BYTES) {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("sandbox_worker_write_timeout")),
        WORKER_TRANSPORT_IDLE_TIMEOUT_MS,
      );
      timer.unref();
      try {
        destination.write(frame.subarray(offset, offset + WRITE_CHUNK_BYTES), (cause) => {
          clearTimeout(timer);
          if (cause) reject(cause);
          else resolve();
        });
      } catch (cause) {
        clearTimeout(timer);
        reject(
          cause instanceof Error ? cause : new Error("sandbox_worker_write_failed", { cause }),
        );
      }
    });
  }
}

interface PendingFrame {
  readonly encode: () => Buffer | undefined;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
}

/**
 * Encode only the frame being written. Large queued requests therefore retain
 * their original input, rather than a second base64/JSON/frame representation.
 * Control frames can pass queued requests, but never split an in-flight frame.
 */
export class WorkerFrameWriter {
  readonly #requests: PendingFrame[] = [];
  readonly #controls: PendingFrame[] = [];
  #writing = false;
  #failure = new Error("sandbox_worker_transport_failed");
  #failed = false;

  public constructor(private readonly destination: Writable) {}

  public enqueue(encode: () => Buffer | undefined, control = false): Promise<void> {
    if (this.#failed) return Promise.reject(this.#failure);
    const result = new Promise<void>((resolve, reject) => {
      (control ? this.#controls : this.#requests).push({ encode, resolve, reject });
    });
    void this.drain();
    return result;
  }

  public fail(cause: unknown): void {
    if (this.#failed) return;
    this.#failed = true;
    this.#failure =
      cause instanceof Error ? cause : new Error("sandbox_worker_transport_failed", { cause });
    for (const pending of [...this.#controls.splice(0), ...this.#requests.splice(0)]) {
      pending.reject(this.#failure);
    }
  }

  private async drain(): Promise<void> {
    if (this.#writing || this.#failed) return;
    this.#writing = true;
    try {
      for (;;) {
        if (this.#failed) return;
        const pending = this.#controls.shift() ?? this.#requests.shift();
        if (pending === undefined) return;
        try {
          const frame = pending.encode();
          if (frame !== undefined) await writeWorkerFrame(this.destination, frame);
          pending.resolve();
        } catch (cause) {
          this.fail(cause);
          pending.reject(this.#failure);
          return;
        }
      }
    } finally {
      this.#writing = false;
    }
  }
}
