import { describe, expect, it } from "vitest";
import { SeatbeltAdmissionQueue } from "./admission.js";
import { SandboxExecutionError } from "../contracts.js";

describe("Seatbelt serial admission", () => {
  it("bounds waiters, releases FIFO and removes aborted queued calls", async () => {
    const queue = new SeatbeltAdmissionQueue(2, 1000);
    const first = await queue.acquire();
    const abort = new AbortController();
    const cancelled = queue.acquire(abort.signal);
    const rejected = expect(cancelled).rejects.toMatchObject({ code: "sandbox_aborted" });
    const second = queue.acquire();
    await expect(queue.acquire()).rejects.toMatchObject({ code: "sandbox_queue_full" });
    abort.abort();
    await rejected;
    first();
    (await second)();
    await queue.idle();
  });
  it("expires admission independently of execution and rejects queued work on close", async () => {
    const queue = new SeatbeltAdmissionQueue(2, 15);
    const release = await queue.acquire();
    await expect(queue.acquire()).rejects.toMatchObject({ code: "sandbox_admission_timeout" });
    const pending = queue.acquire();
    queue.fail(new SandboxExecutionError("sandbox_closed"));
    await expect(pending).rejects.toMatchObject({ code: "sandbox_closed" });
    await expect(queue.acquire()).rejects.toMatchObject({ code: "sandbox_closed" });
    release();
    await queue.idle();
  });
  it("rejects callback reentrance instead of waiting on itself", async () => {
    const queue = new SeatbeltAdmissionQueue();
    await expect(queue.context.run(true, () => queue.acquire())).rejects.toMatchObject({
      code: "sandbox_invalid_request",
    });
  });
  it("charges queued time to the command's submission deadline", async () => {
    const queue = new SeatbeltAdmissionQueue(2, 1000);
    const release = await queue.acquire();
    await expect(queue.acquire(undefined, Date.now() + 15)).rejects.toMatchObject({
      code: "sandbox_timeout",
    });
    release();
    await queue.idle();
  });
});
