import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SmolvmCli } from "./cli.js";
import {
  assertMachineAlive,
  captureMachineIdentity,
  deleteStoppedMachine,
  listMachines,
  stopMachine,
} from "./lifecycle.js";
const directories: string[] = [];
afterEach(async () => {
  for (const dir of directories.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function fixture(state = "running") {
  const root = await mkdtemp("/var/tmp/smol-identity-");
  directories.push(root);
  const directory = path.join(
    root,
    "cache/smolvm/vms",
    createHash("sha256").update("candidate").digest("hex").slice(0, 16),
  );
  await mkdir(directory, { recursive: true });
  const records = [
    {
      name: "candidate",
      state,
      pid: state === "running" ? 123 : (null as number | null),
      parent_machine: null as string | null,
      created_at: 42,
    },
    {
      name: "foreign-name_" + "x".repeat(90),
      state: "running",
      pid: 124,
      parent_machine: null,
      created_at: 43,
    },
  ];
  const behavior = {
    failStop: false,
    failDelete: false,
    failStatus: false,
    failList: false,
    acknowledgeOnly: false,
  };
  const run = vi.fn(({ argv }: { argv: readonly string[] }) => {
    let out = "";
    let exitCode = 0;
    if (argv[1] === "ls") {
      if (behavior.failList) throw Error("foreign machine probe blocked");
      out = JSON.stringify(records);
    }
    if (argv[1] === "status") {
      const record = records.find((r) => r.name === argv[argv.indexOf("--name") + 1]);
      if (!record || behavior.failStatus) exitCode = 1;
      else out = JSON.stringify(record);
    }
    if (argv[1] === "data-dir") out = directory;
    if (argv[1] === "stop") {
      if (behavior.failStop) exitCode = 1;
      else if (!behavior.acknowledgeOnly) {
        records[0]!.state = "stopped";
        records[0]!.pid = null;
      }
    }
    if (argv[1] === "delete") {
      if (behavior.failDelete) exitCode = 1;
      else records.splice(0, 1);
    }
    return Promise.resolve({
      stdout: Buffer.from(out),
      stderr: Buffer.from(exitCode ? "refused" : ""),
      exitCode,
      signal: null,
    });
  });
  const cli = {
    run,
    environment: {
      HOME: root,
      XDG_DATA_HOME: path.join(root, "data"),
      XDG_CACHE_HOME: path.join(root, "cache"),
      SMOLVM_CONFIG: path.join(root, "config"),
    },
  } as unknown as SmolvmCli;
  return { cli, run, records, behavior, directory };
}
describe("stock CLI lifecycle ownership", () => {
  it("uses one named status for each live check without probing unrelated machines", async () => {
    const { cli, run, behavior } = await fixture();
    behavior.failList = true;
    const identity = await captureMachineIdentity(cli, "candidate");
    run.mockClear();
    await assertMachineAlive(cli, identity);
    expect(run.mock.calls.filter(([r]) => r.argv[1] === "status")).toEqual([
      [expect.objectContaining({ argv: ["machine", "status", "--name", "candidate", "--json"] })],
    ]);
    expect(run.mock.calls.some(([r]) => r.argv[1] === "ls")).toBe(false);
  });
  it("does not mistake a failed named status for absence of an existing owned machine", async () => {
    const { cli, run, behavior, records } = await fixture();
    const identity = await captureMachineIdentity(cli, "candidate");
    behavior.failStatus = true;
    await expect(stopMachine(cli, "candidate", identity)).rejects.toMatchObject({
      code: "sandbox_process_failed",
    });
    expect(run.mock.calls.some(([r]) => r.argv[1] === "stop")).toBe(false);
    records.splice(0, 1);
    await stopMachine(cli, "candidate", identity);
    expect(run.mock.calls.some(([r]) => r.argv[1] === "stop")).toBe(false);
  });
  it("checks exact record/directory identity, acknowledges stop and confirms deletion without touching foreign machines", async () => {
    const { cli, run, records } = await fixture();
    const identity = await captureMachineIdentity(cli, "candidate");
    await assertMachineAlive(cli, identity);
    await stopMachine(cli, "candidate", identity);
    await deleteStoppedMachine(cli, "candidate", identity);
    expect(records).toHaveLength(1);
    expect(records[0]!.name).toMatch(/^foreign/);
    expect(
      run.mock.calls
        .filter(([r]) => ["stop", "delete"].includes(r.argv[1]!))
        .every(([r]) => r.argv.includes("candidate")),
    ).toBe(true);
  });
  it.each(["timestamp", "parent", "directory"])(
    "rejects changed %s before stopping or deleting",
    async (mode) => {
      const { cli, run, records, directory } = await fixture();
      const identity = await captureMachineIdentity(cli, "candidate");
      if (mode === "timestamp") records[0]!.created_at++;
      else if (mode === "parent") records[0]!.parent_machine = "foreign";
      else {
        await rename(directory, directory + "-old");
        await mkdir(directory);
      }
      await expect(stopMachine(cli, "candidate", identity)).rejects.toMatchObject({
        code: "sandbox_process_failed",
      });
      await expect(deleteStoppedMachine(cli, "candidate", identity)).rejects.toMatchObject({
        code: "sandbox_process_failed",
      });
      expect(run.mock.calls.some(([r]) => ["stop", "delete"].includes(r.argv[1]!))).toBe(false);
    },
  );
  it("accepts an ordinary cache ancestor alias while retaining canonical data identity", async () => {
    const { cli, run, directory } = await fixture();
    const root = cli.environment.HOME!;
    const alias = path.join(root, "cache-alias");
    await symlink(path.join(root, "cache"), alias);
    const environment = { ...cli.environment, XDG_CACHE_HOME: alias };
    const aliasCli = {
      environment,
      run: (request: { argv: readonly string[] }) =>
        request.argv[1] === "data-dir"
          ? Promise.resolve({
              stdout: Buffer.from(directory.replace(path.join(root, "cache"), alias)),
              stderr: Buffer.alloc(0),
              exitCode: 0,
              signal: null,
            })
          : run(request),
    } as unknown as SmolvmCli;
    expect((await captureMachineIdentity(aliasCli, "candidate")).dataDirectory).toBe(directory);
  });
  it.each(["created", "failed"])(
    "retains unprobed %s even when upstream would acknowledge stop",
    async (state) => {
      const { cli, run } = await fixture(state);
      const identity = await captureMachineIdentity(cli, "candidate", false);
      await expect(stopMachine(cli, "candidate", identity)).rejects.toMatchObject({
        cause: { message: "smolvm_stop_unconfirmed" },
      });
      await expect(deleteStoppedMachine(cli, "candidate", identity)).rejects.toMatchObject({
        cause: { message: "smolvm_delete_requires_stopped_machine" },
      });
      expect(run.mock.calls.some(([r]) => ["stop", "delete"].includes(r.argv[1]!))).toBe(false);
    },
  );
  it("propagates failed stop/delete and rejects acknowledgement without target state", async () => {
    const { cli, behavior } = await fixture();
    const identity = await captureMachineIdentity(cli, "candidate");
    behavior.failStop = true;
    await expect(stopMachine(cli, "candidate", identity)).rejects.toThrow();
    behavior.failStop = false;
    behavior.acknowledgeOnly = true;
    await expect(stopMachine(cli, "candidate", identity)).rejects.toMatchObject({
      cause: { message: "smolvm_stop_unconfirmed" },
    });
    behavior.acknowledgeOnly = false;
    await stopMachine(cli, "candidate", identity);
    behavior.failDelete = true;
    await expect(deleteStoppedMachine(cli, "candidate", identity)).rejects.toThrow();
    expect((await listMachines(cli)).some((r) => r.name === "candidate")).toBe(true);
  });
});
