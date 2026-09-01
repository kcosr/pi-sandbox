import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  HostCommandExecutionError,
  createHostCommandExecutor,
  type HostCommandExecutor,
  type HostCommandRequest,
} from "./index.js";

const executors: HostCommandExecutor[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.allSettled(executors.splice(0).map((executor) => executor.close()));
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true })),
  );
});

function createExecutor(
  options: Parameters<typeof createHostCommandExecutor>[0] = { cwd: process.cwd() },
): HostCommandExecutor {
  const executor = createHostCommandExecutor(options);
  executors.push(executor);
  return executor;
}

function nodeCommand(source: string, ...args: string[]): readonly [string, ...string[]] {
  return [process.execPath, "-e", source, "--", ...args];
}

describe("host command executor", () => {
  it("executes direct argv in the fixed cwd and returns nonzero results", async () => {
    const stdoutUpdates: Buffer[] = [];
    const stderrUpdates: Buffer[] = [];
    const executor = createExecutor({
      cwd: process.cwd(),
      environment: {
        HOME: "/home/example",
        KEEP_ME: "present",
        PI_SANDBOX_INTERNAL_IDENTITY_TOKEN: "secret",
        PI_SANDBOX_INTERNAL_OTHER: "secret-too",
      },
    });

    const result = await executor.execute(
      {
        argv: nodeCommand(
          "process.stdin.on('data', c => process.stdout.write(c)); " +
            "process.on('exit', () => { " +
            "process.stdout.write(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,keep:process.env.KEEP_ME,identity:process.env.PI_SANDBOX_INTERNAL_IDENTITY_TOKEN,argument:process.argv[1]})); " +
            "process.stderr.write('stderr'); }); process.stdin.resume(); process.exitCode=7",
          "> /tmp/not-a-redirection",
        ),
        stdin: "stdin:",
      },
      {
        onStdout: (chunk) => stdoutUpdates.push(chunk),
        onStderr: (chunk) => stderrUpdates.push(chunk),
      },
    );

    expect(result.exitCode).toBe(7);
    expect(result.signal).toBeNull();
    expect(result.stderr.toString()).toBe("stderr");
    expect(Buffer.concat(stderrUpdates).toString()).toBe("stderr");
    expect(Buffer.concat(stdoutUpdates)).toEqual(result.stdout);
    expect(result.stdout.toString()).toBe(
      `stdin:${JSON.stringify({
        cwd: process.cwd(),
        home: "/home/example",
        keep: "present",
        argument: "> /tmp/not-a-redirection",
      })}`,
    );
  });

  it("validates direct argv, input, and per-command limits before spawning", async () => {
    const executor = createExecutor({
      cwd: process.cwd(),
      limits: {
        maximumArgumentBytes: 256,
        maximumInputBytes: 4,
        defaultTimeoutMs: 100,
        maximumTimeoutMs: 200,
        defaultOutputBytes: 16,
        maximumOutputBytes: 32,
      },
    });
    const invalidRequests = [
      { argv: [] },
      { argv: ["node"] },
      { argv: [process.execPath, "bad\0argument"] },
      { argv: [process.execPath, "x".repeat(512)] },
      { argv: [process.execPath], timeoutMs: 0 },
      { argv: [process.execPath], timeoutMs: 201 },
      { argv: [process.execPath], maxOutputBytes: 0 },
      { argv: [process.execPath], maxOutputBytes: 33 },
      { argv: [process.execPath], stdin: 42 },
    ] as unknown as HostCommandRequest[];

    for (const request of invalidRequests) {
      await expect(executor.execute(request)).rejects.toMatchObject({
        code: "host_command_invalid_request",
      });
    }
    await expect(
      executor.execute({ argv: [process.execPath], stdin: "12345" }),
    ).rejects.toMatchObject({ code: "host_command_input_too_large" });
  });

  it("rejects invalid construction limits and launch directories", () => {
    expect(() => createHostCommandExecutor({ cwd: "relative" })).toThrowError(
      expect.objectContaining({ code: "host_command_start_failed" }),
    );
    expect(() =>
      createHostCommandExecutor({
        cwd: process.cwd(),
        limits: { defaultTimeoutMs: 2, maximumTimeoutMs: 1 },
      }),
    ).toThrowError(expect.objectContaining({ code: "host_command_start_failed" }));
  });

  it("terminates commands that exceed their timeout or output limit", async () => {
    const executor = createExecutor({
      cwd: process.cwd(),
      limits: { terminationGraceMs: 20 },
    });

    await expect(
      executor.execute({
        argv: nodeCommand("process.on('SIGTERM', () => {}); setInterval(() => {}, 1000)"),
        timeoutMs: 30,
      }),
    ).rejects.toMatchObject({ code: "host_command_timeout" });

    await expect(
      executor.execute({
        argv: nodeCommand("process.stdout.write('x'.repeat(64))"),
        maxOutputBytes: 8,
      }),
    ).rejects.toMatchObject({ code: "host_command_output_limit_exceeded" });
  });

  it("aborts active commands and rejects calls after close", async () => {
    const executor = createExecutor({
      cwd: process.cwd(),
      limits: { terminationGraceMs: 20 },
    });
    const controller = new AbortController();
    const running = executor.execute(
      { argv: nodeCommand("setInterval(() => {}, 1000)") },
      { signal: controller.signal },
    );
    controller.abort();
    await expect(running).rejects.toMatchObject({ code: "host_command_aborted" });

    const active = executor.execute({ argv: nodeCommand("setInterval(() => {}, 1000)") });
    const closing = executor.close();
    await expect(active).rejects.toMatchObject({ code: "host_command_closed" });
    await closing;
    await expect(executor.execute({ argv: nodeCommand("") })).rejects.toMatchObject({
      code: "host_command_closed",
    });
  });

  it("kills descendants left in the command process group", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pi-sandbox-host-command-"));
    temporaryDirectories.push(directory);
    const marker = join(directory, "descendant-finished");
    const descendant = `setTimeout(() => require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'done'), 250)`;
    const parent = `const child=require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'}); child.unref();`;

    const executor = createExecutor();
    const result = await executor.execute({ argv: nodeCommand(parent) });
    expect(result.exitCode).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 400));
    await expect(access(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports executable startup failures without hanging", async () => {
    const executor = createExecutor();
    await expect(
      executor.execute({ argv: ["/definitely/not/a/pi-sandbox-executable"] }),
    ).rejects.toBeInstanceOf(HostCommandExecutionError);
    await expect(
      executor.execute({ argv: ["/definitely/not/a/pi-sandbox-executable"] }),
    ).rejects.toMatchObject({ code: "host_command_process_failed" });
  });
});
