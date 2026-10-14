import { describe, expect, it } from "vitest";
import { CommandRegistry } from "./command-registry.js";

describe("independent command registration", () => {
  it("admits more than64 calls together and cancels only the selected call", async () => {
    const registry = new CommandRegistry();
    const controllers = Array.from({ length: 72 }, () => new AbortController());
    let started = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = controllers.map((controller) =>
      registry.run(controller.signal, async (signal) => {
        started++;
        await gate;
        if (signal.aborted) throw signal.reason;
        return "peer";
      }),
    );
    expect(started).toBe(72);
    controllers[0]!.abort();
    const results = Promise.allSettled(calls);
    release();
    const settled = await results;
    expect(settled.filter((r) => r.status === "fulfilled")).toHaveLength(71);
    expect(settled[0]).toMatchObject({ status: "rejected", reason: { code: "sandbox_aborted" } });
    await registry.close();
  });
  it("closes admission and aborts preparation before any process can be launched", async () => {
    const registry = new CommandRegistry();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let launched = false;
    const call = registry.run(undefined, async (signal) => {
      await gate;
      if (signal.aborted) throw signal.reason;
      launched = true;
    });
    const failure = expect(call).rejects.toMatchObject({ code: "sandbox_closed" });
    const closed = registry.close();
    await expect(registry.run(undefined, async () => {})).rejects.toMatchObject({
      code: "sandbox_closed",
    });
    release();
    await Promise.all([failure, closed]);
    expect(launched).toBe(false);
  });
});
