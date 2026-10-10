import { describe, expect, it } from "vitest";
import { TerminalSessions } from "./terminals.js";
import type { SmolvmOciTerminalExit, SmolvmOciTerminalLauncher } from "./types.js";

const request = {
  argv: ["/trusted/smolvm"] as const,
  cwd: "/state",
  environment: {},
  columns: 80,
  rows: 24,
  readyMarker: "ready",
};

function fixture(close: () => Promise<void>) {
  let resolve!: (exit: SmolvmOciTerminalExit) => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<SmolvmOciTerminalExit>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  const launch: SmolvmOciTerminalLauncher = () => ({
    completion,
    close,
    write: () => Promise.resolve(),
    resize: () => {},
  });
  return {
    resolve,
    reject,
    options: { terminalType: "xterm-256color", columns: 80, rows: 24, launch },
  };
}

describe("terminal cleanup failure reports", () => {
  it("reports each failed close once without merging failures from separate terminals", async () => {
    const sessions = new TerminalSessions();
    const error = new Error("exec reap unconfirmed");
    const fixtures = [fixture(() => Promise.reject(error)), fixture(() => Promise.reject(error))];
    const handles = await Promise.all(
      fixtures.map((terminal) => sessions.open("candidate", request, terminal.options)),
    );
    try {
      await expect(sessions.closeAll()).rejects.toMatchObject({ errors: [error, error] });
      await expect(sessions.waitFor("candidate")).rejects.toMatchObject({ errors: [error, error] });
    } finally {
      for (const terminal of fixtures) terminal.resolve({ exitCode: null, signal: "SIGKILL" });
      await Promise.all(handles.map((terminal) => terminal.completion));
    }
  });

  it("does not record a rejected completion again when close awaits it", async () => {
    const sessions = new TerminalSessions();
    const terminal = fixture(() => Promise.resolve());
    const handle = await sessions.open("candidate", request, terminal.options);
    const error = new Error("completion could not confirm cleanup");
    terminal.reject(error);
    await expect(handle.completion).rejects.toBe(error);
    await expect(handle.close()).rejects.toBe(error);
    await expect(sessions.closeAll()).rejects.toMatchObject({ errors: [error] });
    await expect(sessions.waitFor("candidate")).rejects.toMatchObject({ errors: [error] });
  });
});
