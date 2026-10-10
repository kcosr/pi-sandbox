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
