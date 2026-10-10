import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, describe, expect, it } from "vitest";
import { SMOLVM_GUEST_COMMAND } from "./guest-command.js";

interface GuestResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
}

const groups: number[] = [];
afterEach(() => {
  for (const pid of groups.splice(0)) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  }
});

function launch(
  argv: readonly string[],
  options: { readonly stdin?: Buffer; readonly delayReading?: boolean } = {},
): {
  readonly child: ChildProcessWithoutNullStreams;
  readonly result: Promise<GuestResult>;
  read(): void;
} {
  const payload = Buffer.from(
    JSON.stringify({ argv, cwd: process.cwd(), environment: {} }),
  ).toString("base64");
  const child = spawn(process.execPath, ["-e", SMOLVM_GUEST_COMMAND, payload], {
    detached: true,
    stdio: ["pipe", "pipe", "pipe"],
  });
  if (child.pid !== undefined) groups.push(child.pid);
  child.stdin.on("error", () => undefined);
  child.stdin.end(options.stdin ?? "");
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const read = () => {
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  };
  if (!options.delayReading) read();
  const result = new Promise<GuestResult>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => {
      resolve({ exitCode, signal, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
  return { child, result, read };
}

function backgroundProgram(body: string): string[] {
  // Wait until the descendant has its timers and inherited pipes in place
  // before exiting the foreground process. This avoids launch-speed timing
  // assumptions in the post-exit tests.
  return [
    process.execPath,
    "-e",
    `const { spawn } = require('node:child_process');
     const child = spawn(process.execPath, ['-e', ${JSON.stringify(body)}], {
       stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
     });
     child.once('message', () => process.exit(0));`,
  ];
}

describe("smolvm per-command guest wrapper", () => {
  it("inherits binary stdin, preserves separate output streams and nonzero exits", async () => {
    const bytes = Buffer.from([0, 255, 10, 128, 42]);
    const { result } = launch(
      [
        process.execPath,
        "-e",
        "process.stdin.pipe(process.stdout);process.stderr.write(Buffer.from([254,0,127]));process.exitCode=7",
      ],
      { stdin: bytes },
    );
    await expect(result).resolves.toEqual({
      exitCode: 7,
      signal: null,
      stdout: bytes,
      stderr: Buffer.from([254, 0, 127]),
    });
  });

  it("retains the existing spawn-error and signalled-command exit mapping", async () => {
    expect((await launch(["/no-such-smolvm-command"]).result).exitCode).toBe(126);
    expect(
      (await launch([process.execPath, "-e", "process.kill(process.pid, 'SIGTERM')"]).result)
        .exitCode,
    ).toBe(137);
  });

  it("releases a silent inherited pipe while leaving the background process running", async () => {
    const { result } = launch(
      backgroundProgram(
        "setInterval(() => {}, 1000);process.stdout.write(String(process.pid));process.send('ready')",
      ),
    );
    const output = await result;
    expect(output.exitCode).toBe(0);
    const pid = Number(output.stdout.toString());
    expect(pid).toBeGreaterThan(1);
    expect(() => process.kill(pid, 0)).not.toThrow();
  });

  it("restarts the post-exit idle period for continuing stdout and stderr", async () => {
    const { result } = launch(
      backgroundProgram(`
        let tick = 0;
        const timer = setInterval(() => {
          (tick % 2 ? process.stderr : process.stdout).write(String(tick));
          if (++tick === 12) {
            clearInterval(timer);
            if (process.connected) process.disconnect();
          }
        }, 40);
        process.send('ready');
      `),
    );
    const output = await result;
    expect(output.exitCode).toBe(0);
    expect(output.stdout.toString()).toBe("0246810");
    expect(output.stderr.toString()).toBe("1357911");
  });

  it("preserves all binary output under host backpressure and flushes before exiting", async () => {
    const count = 4 * 1024 * 1024;
    const command = launch(
      backgroundProgram(`
        process.send('ready');
        process.disconnect();
        process.stdout.write(Buffer.alloc(${count}, 0xa5));
        process.stderr.write(Buffer.alloc(${count}, 0x5a));
      `),
      { delayReading: true },
    );
    // Fill the native pipes before attaching readers. This must not trigger
    // the post-exit idle deadline or unbounded buffering in the wrapper.
    await delay(250);
    command.read();
    const output = await command.result;
    expect(output.exitCode).toBe(0);
    expect(output.stdout.equals(Buffer.alloc(count, 0xa5))).toBe(true);
    expect(output.stderr.equals(Buffer.alloc(count, 0x5a))).toBe(true);
  });
});
