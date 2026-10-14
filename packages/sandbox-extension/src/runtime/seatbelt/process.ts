import { startSandboxProcess, type SandboxProcess } from "../command-process.js";
import type { SandboxExecutionOptions } from "../contracts.js";

export type SeatbeltProcess = SandboxProcess;

/** Only the launcher/profile differ; command lifecycle is shared across backends. */
export function startSeatbeltProcess(
  executable: string,
  argv: readonly string[],
  environment: Readonly<Record<string, string>>,
  stdin: Buffer,
  timeoutMs: number | undefined,
  maxOutputBytes: number,
  options: Pick<SandboxExecutionOptions, "onStdout" | "onStderr"> = {},
): SeatbeltProcess {
  return startSandboxProcess({
    executable,
    argv,
    cwd: "/",
    environment,
    stdin,
    timeoutMs,
    maxOutputBytes,
    ...options,
  });
}
