import type { ChildProcess } from "node:child_process";

const POST_EXIT_IDLE_MS = 100;

export interface CommandExit {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

/**
 * Match Pi 1.1.0's utils/child-process.ts idle drain: after foreground exit,
 * each output chunk restarts the grace period. A fixed post-exit deadline
 * would truncate active output (upstream issue #5303). The worker's ordinary
 * timeout and output limits remain responsible for bounding a noisy descendant.
 */
export function waitForSandboxCommand(child: ChildProcess): Promise<CommandExit> {
  return new Promise((resolve, reject) => {
    let result: CommandExit | undefined;
    let settled = false;
    let idleTimer: NodeJS.Timeout | undefined;
    let stdoutEnded = child.stdout === null;
    let stderrEnded = child.stderr === null;

    const cleanup = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      child.removeListener("close", onClose);
      child.stdout?.removeListener("end", onStdoutEnd);
      child.stderr?.removeListener("end", onStderrEnd);
      child.stdout?.removeListener("data", onData);
      child.stderr?.removeListener("data", onData);
      child.stdin?.destroy();
      child.stdout?.destroy();
      child.stderr?.destroy();
    };
    const finish = (exit: CommandExit): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(exit);
    };
    const armIdleTimer = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        if (result !== undefined) finish(result);
      }, POST_EXIT_IDLE_MS);
    };
    const finishIfEnded = (): void => {
      if (result !== undefined && stdoutEnded && stderrEnded) finish(result);
    };
    const onStdoutEnd = (): void => {
      stdoutEnded = true;
      finishIfEnded();
    };
    const onStderrEnd = (): void => {
      stderrEnded = true;
      finishIfEnded();
    };
    const onData = (): void => {
      if (result !== undefined && !settled) armIdleTimer();
    };
    const onError = (cause: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(cause);
    };
    const onExit = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      result = { exitCode, signal };
      finishIfEnded();
      if (!settled) armIdleTimer();
    };
    const onClose = (exitCode: number | null, signal: NodeJS.Signals | null): void => {
      finish({ exitCode, signal });
    };

    child.stdout?.once("end", onStdoutEnd);
    child.stderr?.once("end", onStderrEnd);
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("close", onClose);
  });
}
