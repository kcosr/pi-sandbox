import { describe, expect, it, vi } from "vitest";
import {
  LINUX_TOOL_COMMANDS,
  type SandboxExecutor,
} from "../../packages/sandbox-extension/src/runtime/index.js";
import { createManagedCleanup, createManagedExecutor } from "./managed-executor.js";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function fixture() {
  const close = vi.fn(() => Promise.resolve());
  const execute = vi.fn(() =>
    Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: Buffer.from("ok"),
      stderr: Buffer.alloc(0),
    }),
  );
  const executor: SandboxExecutor = {
    cwd: "/work",
    home: "/home/agent",
    backend: "smolvm",
    commands: LINUX_TOOL_COMMANDS,
    probe: () => Promise.resolve(),
    execute,
    close,
  };
  const create = vi.fn(() => Promise.resolve(executor));
  return { executor, close, execute, create };
}

describe("process-owned managed executor", () => {
  it("preserves failed cleanup status and retained-state details while awaiting every resource", async () => {
    const originalExitCode = process.exitCode;
    const pending = deferred<void>();
    const failure = new AggregateError(
      [new Error("stop failed")],
      "retained state: /private/vm-123",
    );
    const close = vi.fn(() => Promise.reject(failure));
    const otherClose = vi.fn(() => pending.promise);
    const cleanup = createManagedCleanup(() => [{ close }, { close: otherClose }]);
    try {
      process.exitCode = undefined;
      const first = cleanup();
      const second = cleanup();
      expect(first).toBe(second);
      const rejected = expect(first).rejects.toThrow(
        "retained state: /private/vm-123; stop failed",
      );
      await Promise.resolve();
      expect(process.exitCode).toBeUndefined();
      pending.resolve();
      await rejected;
      expect(process.exitCode).toBe(1);
      expect(close).toHaveBeenCalledTimes(1);
      expect(otherClose).toHaveBeenCalledTimes(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  it("does not start a VM for metadata or CLI error exits", async () => {
    const { create } = fixture();
    const managed = createManagedExecutor({ cwd: "/work", backend: "smolvm", create });
    expect(managed.cwd).toBe("/work");
    expect(managed.backend).toBe("smolvm");
    await managed.close();
    await expect(managed.probe()).rejects.toThrow("sandbox_closed");
    expect(create).not.toHaveBeenCalled();
  });

  it("shares one probed backend across concurrent and replacement-session initialization", async () => {
    const { create, execute, close } = fixture();
    const managed = createManagedExecutor({ cwd: "/work", backend: "smolvm", create });
    expect(() => managed.execute({ argv: ["true"] })).toThrow("sandbox_closed");
    await Promise.all([managed.probe(), managed.probe()]);
    await managed.probe();
    expect(create).toHaveBeenCalledTimes(1);
    expect(managed.home).toBe("/home/agent");
    expect(managed.commands).toBe(LINUX_TOOL_COMMANDS);
    await managed.execute({ argv: ["true"] });
    expect(execute).toHaveBeenCalledWith({ argv: ["true"] }, undefined);
    await Promise.all([managed.close(), managed.close()]);
    expect(close).toHaveBeenCalledTimes(1);
    expect(() => managed.execute({ argv: ["true"] })).toThrow("sandbox_closed");
  });

  it("awaits pending startup and teardown before completing shutdown", async () => {
    const { executor, close } = fixture();
    const starting = deferred<SandboxExecutor>();
    const stopping = deferred<void>();
    close.mockReturnValue(stopping.promise);
    const managed = createManagedExecutor({
      cwd: "/work",
      backend: "smolvm",
      create: () => starting.promise,
    });
    const initialized = expect(managed.probe()).rejects.toThrow("sandbox_closed");
    let finished = false;
    const shutdown = managed.close().then(() => {
      finished = true;
    });
    expect(close).not.toHaveBeenCalled();
    starting.resolve(executor);
    await initialized;
    expect(close).toHaveBeenCalledTimes(1);
    expect(finished).toBe(false);
    stopping.resolve();
    await shutdown;
    expect(finished).toBe(true);
  });

  it("retains initialization failures without retry or fallback", async () => {
    const create = vi.fn(() => Promise.reject(new Error("bad image")));
    const managed = createManagedExecutor({ cwd: "/work", backend: "smolvm", create });
    await expect(managed.probe()).rejects.toThrow("bad image");
    await expect(managed.probe()).rejects.toThrow("bad image");
    await managed.close();
    expect(create).toHaveBeenCalledTimes(1);
  });
});
