import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { waitForSandboxCommand } from "./command-completion.js";

function childFixture(): ChildProcess & { stdout: PassThrough; stderr: PassThrough } {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  }) as unknown as ChildProcess & { stdout: PassThrough; stderr: PassThrough };
}

describe("sandbox command post-exit output", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("retains ongoing output beyond 100ms and waits for 100ms of idle time", async () => {
    const child = childFixture();
    let complete = false;
    const result = waitForSandboxCommand(child).then((value) => {
      complete = true;
      return value;
    });
    child.emit("exit", 7, null);
    for (let index = 0; index < 8; index++) {
      await vi.advanceTimersByTimeAsync(50);
      (index % 2 ? child.stderr : child.stdout).write("still active");
      expect(complete).toBe(false);
    }
    await vi.advanceTimersByTimeAsync(99);
    expect(complete).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toEqual({ exitCode: 7, signal: null });
    expect(child.stdin?.destroyed).toBe(true);
    expect(child.stdout.destroyed).toBe(true);
    expect(child.stderr.destroyed).toBe(true);
    expect(child.stdout.listenerCount("data")).toBe(0);
    expect(child.listenerCount("exit")).toBe(0);
  });

  it("releases quiet inherited pipes and cannot settle again on a late close", async () => {
    const child = childFixture();
    const result = waitForSandboxCommand(child);
    child.emit("exit", null, "SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    child.emit("close", 0, null);
    await expect(result).resolves.toEqual({ exitCode: null, signal: "SIGTERM" });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("completes immediately when both streams finish after exit", async () => {
    const child = childFixture();
    const result = waitForSandboxCommand(child);
    child.emit("exit", 0, null);
    child.stdout.emit("end");
    child.stderr.emit("end");
    await expect(result).resolves.toEqual({ exitCode: 0, signal: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans up pipes and any timer after a process error", async () => {
    const child = childFixture();
    const result = waitForSandboxCommand(child);
    const failed = expect(result).rejects.toThrow("spawn failed");
    child.emit("exit", 0, null);
    child.emit("error", new Error("spawn failed"));
    await failed;
    expect(child.stdout.destroyed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});
