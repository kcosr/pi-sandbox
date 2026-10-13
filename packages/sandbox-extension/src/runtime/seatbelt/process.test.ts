import { describe, expect, it, vi } from "vitest";
import { startSeatbeltProcess } from "./process.js";
import { SandboxExecutionError } from "../contracts.js";

function run(
  script: string,
  input = Buffer.alloc(0),
  timeout = 3000,
  bytes = 1_048_576,
  options: Parameters<typeof startSeatbeltProcess>[6] = {},
) {
  return startSeatbeltProcess(
    process.execPath,
    ["-e", script],
    { PATH: "/usr/bin:/bin" },
    input,
    timeout,
    bytes,
    options,
  );
}
describe("Seatbelt command pipe lifecycle", () => {
  it("preserves binary stdin/stdout and streams callbacks before completion", async () => {
    const input = Buffer.from(Array.from({ length: 262_144 }, (_, index) => index % 256));
    const chunks: Buffer[] = [];
    const child = run("process.stdin.pipe(process.stdout)", input, 3000, input.length, {
      onStdout: (chunk) => chunks.push(chunk),
    });
    const result = await child.result;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toEqual(input);
    expect(Buffer.concat(chunks)).toEqual(input);
  });
  it("bounds output, deadline and callback failure and tolerates early stdin close", async () => {
    await expect(
      run("process.stdout.write(Buffer.alloc(4096))", undefined, 3000, 32).result,
    ).rejects.toMatchObject({ code: "sandbox_output_limit_exceeded" });
    await expect(run("setInterval(()=>{},1000)", undefined, 30).result).rejects.toMatchObject({
      code: "sandbox_timeout",
    });
    await expect(
      run("console.log('ready')", undefined, 3000, 1024, {
        onStdout: () => {
          throw new Error("consumer");
        },
      }).result,
    ).rejects.toMatchObject({ code: "sandbox_process_failed" });
    expect((await run("process.exit(0)", Buffer.alloc(1_048_576)).result).exitCode).toBe(0);
  });
  it("does not signal a reaped process group on completion or late cancellation", async () => {
    const kill = vi.spyOn(process, "kill");
    try {
      const child = run("process.exit(0)");
      await child.result;
      child.abort(new SandboxExecutionError("sandbox_aborted"));
      expect(kill).not.toHaveBeenCalled();
    } finally {
      kill.mockRestore();
    }
  });
  it("continues draining background output until both streams are quiet", async () => {
    // This deliberately records that successful foreground exit does not kill
    // background descendants. The fixture self-terminates after finite output.
    const script =
      "let i=0;const t=setInterval(()=>{console.log(++i);if(i===5)clearInterval(t)},40)";
    const child = run(
      `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(script)}],{stdio:['ignore',1,2]}); process.exit(0)`,
    );
    expect((await child.result).stdout.toString().trim().split("\n")).toEqual([
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
  });
});
