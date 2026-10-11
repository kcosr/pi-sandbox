import { createHash } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import path from "node:path";
import { SandboxExecutionError, type SandboxCommandResult } from "../contracts.js";
import type { SmolvmCli } from "./cli.js";
import { registryIdentity, resolvedPath, validMachineName } from "./registry.js";

export interface MachineIdentity {
  readonly name: string;
  readonly createdAt: number;
  readonly parent: string | null;
  readonly dataDirectory: string | null;
  readonly dev: number | null;
  readonly ino: number | null;
}
export interface MachineRecord {
  readonly name: string;
  readonly state: string;
  readonly pid: number | null;
  readonly parent: string | null;
  readonly createdAt: number;
}
const fail = (message: string) =>
  new SandboxExecutionError("sandbox_process_failed", { cause: new Error(message) });
export async function checkedCommand(
  cli: SmolvmCli,
  argv: readonly [string, ...string[]],
): Promise<SandboxCommandResult> {
  const result = await cli.run({ argv, timeoutMs: 180_000, maxOutputBytes: 4 * 1_048_576 });
  if (result.exitCode !== 0 || result.signal !== null)
    throw fail(`smolvm_command_failed: ${result.stderr.toString().slice(-2000)}`);
  return result;
}
export async function listMachines(cli: SmolvmCli): Promise<readonly MachineRecord[]> {
  const raw: unknown = JSON.parse(
    (await checkedCommand(cli, ["machine", "ls", "--json"])).stdout.toString(),
  );
  if (!Array.isArray(raw)) throw fail("smolvm_machine_list_invalid");
  const names = new Set<string>();
  return raw.map((item: unknown) => {
    if (!item || typeof item !== "object") throw fail("smolvm_machine_list_invalid");
    const r = item as Record<string, unknown>;
    if (
      !validMachineName(r.name) ||
      names.has(r.name) ||
      typeof r.state !== "string" ||
      !(
        r.pid === null ||
        (typeof r.pid === "number" && Number.isSafeInteger(r.pid) && r.pid > 0)
      ) ||
      !(r.parent_machine === null || validMachineName(r.parent_machine)) ||
      !Number.isSafeInteger(r.created_at) ||
      (r.created_at as number) < 0
    )
      throw fail("smolvm_machine_list_invalid");
    names.add(r.name);
    return {
      name: r.name,
      state: r.state,
      pid: r.pid,
      parent: r.parent_machine,
      createdAt: r.created_at as number,
    };
  });
}
export function validateMachineIdentity(value: unknown): asserts value is MachineIdentity {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).sort().join(",") !== "createdAt,dataDirectory,dev,ino,name,parent"
  )
    throw fail("smolvm_machine_identity_invalid");
  const r = value as MachineIdentity;
  if (
    !validMachineName(r.name) ||
    !(r.parent === null || validMachineName(r.parent)) ||
    !Number.isSafeInteger(r.createdAt) ||
    r.createdAt < 0 ||
    !(r.dataDirectory === null
      ? r.dev === null && r.ino === null
      : typeof r.dataDirectory === "string" &&
        path.isAbsolute(r.dataDirectory) &&
        Number.isSafeInteger(r.dev) &&
        Number.isSafeInteger(r.ino))
  )
    throw fail("smolvm_machine_identity_invalid");
}
export async function captureMachineIdentity(
  cli: SmolvmCli,
  name: string,
  running = true,
): Promise<MachineIdentity> {
  const record = (await listMachines(cli)).find((r) => r.name === name);
  if (!record || (running && !["running", "frozen"].includes(record.state)))
    throw fail("smolvm_machine_not_running");
  const reportedDirectory = (
    await checkedCommand(cli, ["machine", "data-dir", "--name", name])
  ).stdout
    .toString()
    .trim();
  const directory = await resolvedPath(reportedDirectory);
  const registry = await registryIdentity(cli.environment);
  const expected = path.join(
    registry.cacheDirectory,
    "smolvm/vms",
    createHash("sha256").update(name).digest("hex").slice(0, 16),
  );
  if (directory !== expected) throw fail("smolvm_data_directory_invalid");
  let stat;
  try {
    stat = await lstat(reportedDirectory);
  } catch (error) {
    if (
      !running &&
      record.state === "created" &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    )
      return {
        name,
        createdAt: record.createdAt,
        parent: record.parent,
        dataDirectory: null,
        dev: null,
        ino: null,
      };
    throw error;
  }
  if (!stat.isDirectory() || (await realpath(directory)) !== directory)
    throw fail("smolvm_data_directory_invalid");
  return {
    name,
    createdAt: record.createdAt,
    parent: record.parent,
    dataDirectory: directory,
    dev: stat.dev,
    ino: stat.ino,
  };
}
export async function assertMachineIdentity(
  cli: SmolvmCli,
  identity: MachineIdentity,
): Promise<MachineRecord | undefined> {
  const record = (await listMachines(cli)).find((r) => r.name === identity.name);
  if (!record) return undefined;
  if (record.createdAt !== identity.createdAt || record.parent !== identity.parent)
    throw fail("smolvm_machine_identity_changed");
  if (identity.dataDirectory !== null) {
    const current = await captureMachineIdentity(cli, identity.name, false);
    if (
      current.dataDirectory !== identity.dataDirectory ||
      current.dev !== identity.dev ||
      current.ino !== identity.ino
    )
      throw fail("smolvm_machine_identity_changed");
  }
  return record;
}
export async function assertMachineAlive(cli: SmolvmCli, identity: MachineIdentity): Promise<void> {
  const record = await assertMachineIdentity(cli, identity);
  if (!record || !["running", "frozen"].includes(record.state))
    throw fail("smolvm_machine_not_running");
}
/** Stock acknowledgement plus target status; never claims independent VMM death proof. */
export async function stopMachine(
  cli: SmolvmCli,
  name: string,
  identity: MachineIdentity,
): Promise<void> {
  if (name !== identity.name) throw fail("smolvm_machine_identity_changed");
  const record = await assertMachineIdentity(cli, identity);
  if (!record) return;
  if (!["running", "frozen", "unreachable", "stopped"].includes(record.state))
    throw fail("smolvm_stop_unconfirmed");
  await checkedCommand(cli, ["machine", "stop", "--name", name]);
  const stopped = await assertMachineIdentity(cli, identity);
  if (!stopped || stopped.state !== "stopped" || stopped.pid !== null)
    throw fail("smolvm_stop_unconfirmed");
}
export async function deleteStoppedMachine(
  cli: SmolvmCli,
  name: string,
  identity: MachineIdentity,
): Promise<void> {
  if (name !== identity.name) throw fail("smolvm_machine_identity_changed");
  const record = await assertMachineIdentity(cli, identity);
  if (!record) return;
  if (record.state !== "stopped" || record.pid !== null)
    throw fail("smolvm_delete_requires_stopped_machine");
  await checkedCommand(cli, ["machine", "delete", "--name", name, "--force"]);
  if ((await listMachines(cli)).some((r) => r.name === name))
    throw fail("smolvm_delete_unconfirmed");
}
