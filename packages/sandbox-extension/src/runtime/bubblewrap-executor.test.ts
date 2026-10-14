import { chmod, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createBubblewrapExecutor } from "./bubblewrap-executor.js";
import type { SandboxExecutor, SandboxResourceLimits } from "./contracts.js";

// This is a protocol peer, not a sandbox or an isolation substitute. It runs no
// submitted command. Linux integration tests separately qualify real Bubblewrap.
describe("Bubblewrap parent protocol bookkeeping", () => {
  let directory: string;
  let executor: SandboxExecutor | undefined;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(path.join(tmpdir(), "pi-worker-parent-")));
  });
  afterEach(async () => {
    await executor?.close();
    executor = undefined;
    await rm(directory, { recursive: true, force: true });
  });

  async function create(mode = "ordinary", limits?: SandboxResourceLimits) {
    const launcher = path.join(directory, "protocol-peer");
    await writeFile(
      launcher,
      `#!${process.execPath}
const fs = require("node:fs");
const mode = ${JSON.stringify(mode)};
const send = value => {
  const payload = Buffer.from(JSON.stringify(value));
  const frame = Buffer.alloc(payload.length + 4);
  frame.writeUInt32BE(payload.length); payload.copy(frame, 4); process.stdout.write(frame);
};
fs.writeSync(3, JSON.stringify({"child-pid": process.pid}) + "\\n");
fs.createReadStream(null, {fd:4}).resume();
send({type:"ready",protocolVersion:4});
let input = Buffer.alloc(0);
const active = new Map();
let released = false;
if (mode === "backlog") { process.stdin.pause(); setTimeout(() => process.stdin.resume(), 400); }
process.stdin.on("data", chunk => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4 && input.length >= input.readUInt32BE(0) + 4) {
    const length = input.readUInt32BE(0) + 4;
    const request = JSON.parse(input.subarray(4, length)); input = input.subarray(length);
    if (request.type === "shutdown") { process.exit(0); }
    if (request.type === "cancel") {
      const task = active.get(request.id);
      if (task) { clearTimeout(task); active.delete(request.id); send({type:"failure",id:request.id,code:"sandbox_aborted"}); }
      continue;
    }
    if (request.type !== "execute") process.exit(71);
    send({type:"started",id:request.id});
    const finish = () => { active.delete(request.id); send({type:"stdout",id:request.id,data:Buffer.from(JSON.stringify({argv:request.argv,timeoutMs:request.timeoutMs})).toString("base64")}); send({type:"result",id:request.id,exitCode:0,signal:null}); };
    if (mode === "concurrent") {
      active.set(request.id, finish);
      if (active.size === 72 && !released) { released = true; for (const callback of [...active.values()]) callback(); }
    } else {
      const timer = setTimeout(finish, request.argv[1] === "held" ? 2000 : mode === "late-result" ? 200 : 5);
      active.set(request.id, timer);
    }
  }
});
`,
    );
    await chmod(launcher, 0o755);
    executor = await createBubblewrapExecutor({
      cwd: directory,
      bubblewrapPath: launcher,
      ...(limits === undefined ? {} : { limits }),
      workerCommand: [process.execPath],
    });
    return executor;
  }

  it("rejects removed lifetime and default-timeout options instead of silently ignoring them", async () => {
    await expect(
      createBubblewrapExecutor({
        cwd: directory,
        bubblewrapPath: "/missing",
        processLifetime: "sandbox",
      } as never),
    ).rejects.toMatchObject({
      code: "sandbox_start_failed",
      cause: { message: "sandbox_process_lifetime_removed" },
    });
    await expect(
      createBubblewrapExecutor({
        cwd: directory,
        bubblewrapPath: "/missing",
        limits: { defaultTimeoutMs: 1 },
      } as never),
    ).rejects.toMatchObject({
      code: "sandbox_start_failed",
      cause: { message: "sandbox_limits_invalid" },
    });
  });

  it("passes an unlimited request without adding a timer and accepts more than sixty-four calls", async () => {
    const backend = await create("concurrent");
    const results = await Promise.all(
      Array.from({ length: 72 }, (_, index) =>
        backend.execute({ argv: ["/bin/echo", String(index)] }),
      ),
    );
    results.forEach((result, index) => {
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual({ argv: ["/bin/echo", String(index)] });
    });
  });

  it("lets the worker own the deadline rather than timing out a delayed result at the parent", async () => {
    const backend = await create("late-result");
    await expect(backend.execute({ argv: ["/bin/true"], timeoutMs: 20 })).resolves.toMatchObject({
      exitCode: 0,
    });
  });

  it("resolves an optional policy maximum and rejects larger caller values", async () => {
    const backend = await create("ordinary", { maximumTimeoutMs: 1_000 });
    for (const timeoutMs of [undefined, 0.5, 750]) {
      const result = await backend.execute({
        argv: ["/bin/true"],
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
      });
      expect(JSON.parse(result.stdout.toString()) as unknown).toMatchObject({
        timeoutMs: timeoutMs ?? 1_000,
      });
    }
    await expect(backend.execute({ argv: ["/bin/true"], timeoutMs: 1001 })).rejects.toMatchObject({
      code: "sandbox_invalid_request",
      cause: { message: "Command timeout exceeds administrator maximum of 1000 milliseconds" },
    });
  });

  it("removes a cancelled queued frame and snapshots request arguments under backpressure", async () => {
    const backend = await create("backlog");
    const first = backend.execute({ argv: ["/bin/cat"], stdin: Buffer.alloc(2 * 1_048_576) });
    const controller = new AbortController();
    const cancelled = backend.execute(
      { argv: ["/bin/touch", "should-not-run"] },
      { signal: controller.signal },
    );
    const rejected = expect(cancelled).rejects.toMatchObject({ code: "sandbox_aborted" });
    controller.abort();
    const argv: [string, ...string[]] = ["/bin/printf", "original"];
    const next = backend.execute({ argv, timeoutMs: 10 });
    argv[1] = "mutated";
    await rejected;
    expect((await first).exitCode).toBe(0);
    expect(JSON.parse((await next).stdout.toString()) as unknown).toMatchObject({
      argv: ["/bin/printf", "original"],
    });
  });

  it("cancels one active request without rejecting a peer or future requests", async () => {
    const backend = await create();
    const controller = new AbortController();
    const held = backend.execute({ argv: ["/bin/sleep", "held"] }, { signal: controller.signal });
    const failed = expect(held).rejects.toMatchObject({ code: "sandbox_aborted" });
    const peer = backend.execute({ argv: ["/bin/true"] });
    controller.abort();
    await failed;
    expect((await peer).exitCode).toBe(0);
    expect((await backend.execute({ argv: ["/bin/true"] })).exitCode).toBe(0);
  });
});
