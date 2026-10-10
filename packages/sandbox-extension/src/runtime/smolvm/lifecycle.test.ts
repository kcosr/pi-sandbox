import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SmolvmCli } from "./cli.js";
import {
  assertMachineAlive,
  captureMachineIdentity,
  deleteStoppedMachine,
  stopMachine,
} from "./lifecycle.js";

const state = vi.hoisted(() => ({
  exists: true,
  start: "1234",
  boot: "/private/state/boot.json",
  failStop: false,
  processState: "S",
  cmdline: undefined as string | undefined,
  afterCmdline: undefined as (() => void) | undefined,
  afterStop: undefined as (() => void) | undefined,
}));
vi.mock("node:fs/promises", () => ({
  readFile: (name: string) => {
    if (!state.exists) return Promise.reject(Object.assign(new Error("gone"), { code: "ENOENT" }));
    if (name.endsWith("/stat")) {
      const fields = Array<string>(20).fill("0");
      fields[0] = state.processState;
      fields[19] = state.start;
      return Promise.resolve(`4321 (vm name) ${fields.join(" ")}`);
    }
    const cmdline = state.cmdline ?? `/proc/self/exe\0_boot-vm\0${state.boot}\0`;
    const after = state.afterCmdline;
    state.afterCmdline = undefined;
    after?.();
    return Promise.resolve(cmdline);
  },
}));

function fixture(created = false) {
  let present = true;
  let stopped = false;
  const run = vi.fn((request: { argv: readonly string[] }) => {
    let out = "";
    if (request.argv[1] === "ls")
      out = JSON.stringify(
        present
          ? [
              {
                name: "candidate",
                state: created ? "created" : !stopped && state.exists ? "running" : "stopped",
                pid: !created && !stopped && state.exists ? 4321 : null,
                parent_machine: null,
              },
            ]
          : [],
      );
    if (request.argv[1] === "stop") {
      if (state.failStop)
        return Promise.resolve({
          exitCode: 1,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.from("sync failed"),
        });
      if (!created) {
        state.exists = false;
        stopped = true;
      }
      state.afterStop?.();
    }
    if (request.argv[1] === "delete") present = false;
    return Promise.resolve({
      exitCode: 0,
      signal: null,
      stdout: Buffer.from(out),
      stderr: Buffer.alloc(0),
    });
  });
  return {
    run,
    removeRecord: () => {
      present = false;
    },
    cli: {
      run,
      smolvmPath: "/runtime/smolvm",
      stateDirectory: "/private/state",
    } as unknown as SmolvmCli,
  };
}

beforeEach(() => {
  state.exists = true;
  state.start = "1234";
  state.boot = "/private/state/boot.json";
  state.failStop = false;
  state.processState = "S";
  state.cmdline = undefined;
  state.afterCmdline = undefined;
  state.afterStop = undefined;
});

describe("named machine lifecycle identity", () => {
  it("verifies actual boot identity before and after stopping, then permits deletion", async () => {
    const { cli, run } = fixture();
    const identity = await captureMachineIdentity(cli, "candidate");
    await assertMachineAlive(identity);
    await stopMachine(cli, "candidate", identity);
    await deleteStoppedMachine(cli, "candidate");
    expect(run.mock.calls.filter(([request]) => request.argv[1] === "stop")).toHaveLength(1);
    expect(run.mock.calls.filter(([request]) => request.argv[1] === "delete")).toHaveLength(1);
  });
  it("does not stop a recycled PID or accept a boot path outside private state", async () => {
    const { cli, run } = fixture();
    const identity = await captureMachineIdentity(cli, "candidate");
    state.start = "5678";
    await expect(stopMachine(cli, "candidate", identity)).rejects.toMatchObject({
      code: "sandbox_process_failed",
    });
    expect(run.mock.calls.some(([request]) => request.argv[1] === "stop")).toBe(false);
    state.boot = "/unrelated/boot.json";
    await expect(captureMachineIdentity(cli, "candidate")).rejects.toMatchObject({
      code: "sandbox_process_failed",
    });
  });
  it("propagates failed stop and refuses deleting a running VM", async () => {
    const { cli, run } = fixture();
    const identity = await captureMachineIdentity(cli, "candidate");
    state.failStop = true;
    await expect(stopMachine(cli, "candidate", identity)).rejects.toMatchObject({
      code: "sandbox_process_failed",
    });
    await expect(deleteStoppedMachine(cli, "candidate")).rejects.toMatchObject({
      code: "sandbox_process_failed",
    });
    expect(run.mock.calls.some(([request]) => request.argv[1] === "delete")).toBe(false);
  });
  it("confirms an exit between the first stat and an empty command-line read", async () => {
    const { cli } = fixture();
    const identity = await captureMachineIdentity(cli, "candidate");
    state.afterStop = () => {
      state.exists = true;
      state.cmdline = "";
      state.afterCmdline = () => {
        state.processState = "Z";
      };
    };
    await expect(stopMachine(cli, "candidate", identity)).resolves.toBeUndefined();
    await expect(deleteStoppedMachine(cli, "candidate")).resolves.toBeUndefined();
  });
  it("confirms the original VMM stopped when its PID now belongs to another program", async () => {
    const { cli } = fixture();
    const identity = await captureMachineIdentity(cli, "candidate");
    state.afterStop = () => {
      state.exists = true;
      state.start = "5678";
      state.cmdline = "/usr/bin/other\0argument\0";
    };
    await expect(stopMachine(cli, "candidate", identity)).resolves.toBeUndefined();
    await expect(deleteStoppedMachine(cli, "candidate")).resolves.toBeUndefined();
  });
  it("requires the exact live identity before calling a missing record an orphan", async () => {
    const { cli, run, removeRecord } = fixture();
    const identity = await captureMachineIdentity(cli, "candidate");
    removeRecord();
    await expect(stopMachine(cli, "candidate", identity)).rejects.toMatchObject({
      cause: { message: "smolvm_live_machine_record_missing" },
    });
    state.start = "5678";
    state.cmdline = "/usr/bin/other\0argument\0";
    await expect(stopMachine(cli, "candidate", identity)).resolves.toBeUndefined();
    expect(run.mock.calls.some(([request]) => request.argv[1] === "stop")).toBe(false);
  });
  it("still rejects an unrelated program during capture, use, and pre-stop admission", async () => {
    const { cli, run } = fixture();
    const identity = await captureMachineIdentity(cli, "candidate");
    state.start = "5678";
    state.cmdline = "/usr/bin/other\0argument\0";
    await expect(captureMachineIdentity(cli, "candidate")).rejects.toMatchObject({
      cause: { message: "smolvm_process_identity_invalid" },
    });
    await expect(assertMachineAlive(identity)).rejects.toMatchObject({
      code: "sandbox_process_failed",
    });
    await expect(stopMachine(cli, "candidate", identity)).rejects.toMatchObject({
      code: "sandbox_process_failed",
    });
    expect(run.mock.calls.some(([request]) => request.argv[1] === "stop")).toBe(false);
  });
  it.each([false, true])(
    "retains an unprobed created record after successful stop (unrecorded process present: %s)",
    async (processPresent) => {
      state.exists = processPresent;
      const { cli, run } = fixture(true);
      // Upstream leaves Created unchanged on stop, with no persisted PID to
      // inspect. Its successful exit cannot distinguish these two situations.
      await expect(stopMachine(cli, "candidate")).rejects.toMatchObject({
        code: "sandbox_process_failed",
        cause: { message: "smolvm_stop_unconfirmed" },
      });
      await expect(deleteStoppedMachine(cli, "candidate")).rejects.toMatchObject({
        code: "sandbox_process_failed",
        cause: { message: "smolvm_delete_requires_stopped_machine" },
      });
      expect(run.mock.calls.filter(([request]) => request.argv[1] === "stop")).toHaveLength(1);
      expect(run.mock.calls.some(([request]) => request.argv[1] === "delete")).toBe(false);
      expect(state.exists).toBe(processPresent);
    },
  );
});
