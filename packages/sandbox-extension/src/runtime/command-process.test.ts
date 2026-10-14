import { describe, expect, it, vi } from "vitest";
import { startSandboxProcess, type SandboxProcessOptions } from "./command-process.js";
import { SandboxExecutionError } from "./contracts.js";

function run(script: string, options: Partial<SandboxProcessOptions> = {}) {
  return startSandboxProcess({
    executable: process.execPath,
    argv: ["-e", script],
    cwd: "/",
    environment: { PATH: "/usr/bin:/bin" },
    stdin: Buffer.alloc(0),
    timeoutMs: undefined,
    maxOutputBytes: 4_194_304,
    ...options,
  });
}

describe("shared command execution", () => {
  it("does not create a command deadline when omitted and accepts durations above ten minutes", async () => {
    const timers = vi.spyOn(globalThis, "setTimeout");
    try {
      expect((await run("process.stdout.write('done')").result).exitCode).toBe(0);
      expect(timers.mock.calls.some(([, ms]) => ms === 120_000 || ms === 600_000)).toBe(false);
      expect((await run("process.exit(0)", { timeoutMs: 3_600_000 }).result).exitCode).toBe(0);
      expect(timers.mock.calls.some(([, ms]) => ms === 3_600_000)).toBe(true);
    } finally {
      timers.mockRestore();
    }
  });
  it("preserves all output through slow asynchronous consumers and reports their failure locally", async () => {
    const chunks: Buffer[] = [];
    const result = await run("process.stdout.write(Buffer.alloc(524288,7))", {
      onStdout: async (chunk) => {
        await new Promise((resolve) => setTimeout(resolve, 125));
        chunks.push(chunk);
      },
    }).result;
    expect(Buffer.concat(chunks)).toEqual(Buffer.alloc(524288, 7));
    expect(result.stdout).toEqual(Buffer.concat(chunks));
    await expect(
      run("console.log('output')", {
        onStdout: () => Promise.reject(new Error("consumer failed")),
      }).result,
    ).rejects.toMatchObject({ code: "sandbox_process_failed" });
  });
  it("settles cancellation during post-exit output draining without late group signalling", async () => {
    let ready!: () => void;
    const output = new Promise<void>((resolve) => {
      ready = resolve;
    });
    const kill = vi.spyOn(process, "kill");
    const finite =
      "let n=0;console.log('ready');process.send('ready');const t=setInterval(()=>{console.log('tick');if(++n===20)clearInterval(t)},30)";
    const processRun = run(
      `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(finite)}],{stdio:['ignore',1,2,'ipc']}).once('message',()=>process.exit(0))`,
      { onStdout: () => ready() },
    );
    try {
      await output;
      await new Promise((resolve) => setTimeout(resolve, 150));
      processRun.abort(new SandboxExecutionError("sandbox_aborted"));
      await expect(processRun.result).rejects.toMatchObject({ code: "sandbox_aborted" });
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
      await new Promise((resolve) => setTimeout(resolve, 600));
    }
  });
  it("reports denied signalling instead of hanging a request indefinitely", async () => {
    let ready!: (pid: number) => void;
    const pid = new Promise<number>((resolve) => {
      ready = resolve;
    });
    const child = run("console.log(process.pid);setInterval(()=>{},1000)", {
      onStdout: (chunk) => ready(Number(chunk.toString().trim())),
    });
    const ownedPid = await pid;
    const originalKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("fixture denial"), { code: "EPERM" });
    });
    try {
      child.abort(new SandboxExecutionError("sandbox_aborted"));
      await expect(child.result).rejects.toMatchObject({
        code: "sandbox_aborted",
        cause: { code: "EPERM" },
      });
    } finally {
      kill.mockRestore();
      originalKill(-ownedPid, "SIGKILL");
    }
  });
});
