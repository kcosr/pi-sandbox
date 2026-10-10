import { describe, expect, it } from "vitest";
import { SandboxExecutionError } from "../contracts.js";
import { AdmissionQueue } from "./admission.js";

describe("smolvm serial admission", () => {
  it("bounds pending work and aborts a queued request without disturbing its owner", async () => {
    const queue = new AdmissionQueue(1, 1000);
    const release = await queue.acquire();
    const controller = new AbortController();
    const waiting = queue.acquire({ signal: controller.signal });
    const rejected = expect(waiting).rejects.toMatchObject({ code: "sandbox_aborted" });
    await expect(queue.acquire()).rejects.toMatchObject({ code: "sandbox_queue_full" });
    controller.abort();
    await rejected;
    release();
    const next = await queue.acquire();
    next();
    await queue.idle();
  });
  it("revokes pending and future work on retirement", async () => {
    const queue = new AdmissionQueue();
    const release = await queue.acquire();
    const waiting = queue.acquire();
    queue.fail(new SandboxExecutionError("sandbox_closed"));
    await expect(waiting).rejects.toMatchObject({ code: "sandbox_closed" });
    await expect(queue.acquire()).rejects.toMatchObject({ code: "sandbox_closed" });
    release();
    await queue.idle();
  });
});
