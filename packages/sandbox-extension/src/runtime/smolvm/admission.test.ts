import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxExecutionError } from "../contracts.js";
import { AdmissionQueue } from "./admission.js";

afterEach(() => vi.useRealTimers());

describe("smolvm bounded parallel admission", () => {
  it("bounds pending work and aborts a queued request without disturbing its owner", async () => {
    const queue = new AdmissionQueue({ capacity: 2, concurrency: 1, timeoutMs: 1000 });
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
    const queue = new AdmissionQueue({ concurrency: 1 });
    const release = await queue.acquire();
    const waiting = queue.acquire();
    queue.fail(new SandboxExecutionError("sandbox_closed"));
    await expect(waiting).rejects.toMatchObject({ code: "sandbox_closed" });
    await expect(queue.acquire()).rejects.toMatchObject({ code: "sandbox_closed" });
    release();
    await queue.idle();
  });
  it("allows four active requests and bounds all outstanding requests at 64", async () => {
    const queue = new AdmissionQueue();
    const active = await Promise.all(Array.from({ length: 4 }, () => queue.acquire()));
    const waiting = Array.from({ length: 60 }, () => queue.acquire());
    await expect(queue.acquire()).rejects.toMatchObject({ code: "sandbox_queue_full" });
    expect(() => queue.assertAvailable()).toThrow("sandbox_queue_full");
    queue.fail(new SandboxExecutionError("sandbox_closed"));
    const results = await Promise.allSettled(waiting);
    expect(results.every((result) => result.status === "rejected")).toBe(true);
    for (const release of active) release();
    await queue.idle();
  });
  it("does not let later execution overtake an exclusive lifecycle request", async () => {
    const queue = new AdmissionQueue();
    const first = await queue.acquire();
    const second = await queue.acquire();
    const admitted: string[] = [];
    const lifecycle = queue.acquire({ exclusive: true }).then((release) => {
      admitted.push("lifecycle");
      return release;
    });
    const execution = queue.acquire().then((release) => {
      admitted.push("execution");
      return release;
    });
    first();
    await Promise.resolve();
    expect(admitted).toEqual([]);
    second();
    const releaseLifecycle = await lifecycle;
    expect(admitted).toEqual(["lifecycle"]);
    releaseLifecycle();
    const releaseExecution = await execution;
    expect(admitted).toEqual(["lifecycle", "execution"]);
    releaseExecution();
    await queue.idle();
  });
  it("unblocks execution if a waiting exclusive request is cancelled", async () => {
    const queue = new AdmissionQueue();
    const active = await queue.acquire();
    const controller = new AbortController();
    const lifecycle = queue.acquire({ exclusive: true, signal: controller.signal });
    const rejected = expect(lifecycle).rejects.toMatchObject({ code: "sandbox_aborted" });
    const next = queue.acquire();
    controller.abort();
    await rejected;
    (await next)();
    active();
    await queue.idle();
  });
  it("expires only a queued request at its request deadline", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const queue = new AdmissionQueue({ concurrency: 1 });
    const active = await queue.acquire();
    const waiting = queue.acquire({ deadline: performance.now() + 30 });
    const rejected = expect(waiting).rejects.toMatchObject({ code: "sandbox_timeout" });
    await vi.advanceTimersByTimeAsync(30);
    await rejected;
    active();
    (await queue.acquire())();
    await queue.idle();
  });
  it("waits for every active lease during shutdown and release is idempotent", async () => {
    const queue = new AdmissionQueue();
    const first = await queue.acquire();
    const second = await queue.acquire();
    queue.fail(new SandboxExecutionError("sandbox_closed"));
    let idle = false;
    const done = queue.idle().then(() => {
      idle = true;
    });
    first();
    first();
    await Promise.resolve();
    expect(idle).toBe(false);
    second();
    await done;
    expect(idle).toBe(true);
  });
});
