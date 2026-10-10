import { readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SandboxExecutionError, type SandboxCommandResult } from "../contracts.js";
import type { SmolvmCli } from "./cli.js";

export interface MachineIdentity {
  readonly pid: number;
  readonly start: string;
  readonly executable: string;
  readonly bootConfig: string;
}

export interface MachineRecord {
  readonly name: string;
  readonly state: string;
  readonly pid: number | null;
  readonly parent: string | null;
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
      typeof r.name !== "string" ||
      !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/u.test(r.name) ||
      names.has(r.name) ||
      typeof r.state !== "string" ||
      !(
        r.pid === null ||
        (typeof r.pid === "number" && Number.isSafeInteger(r.pid) && r.pid > 0)
      ) ||
      !(r.parent_machine === null || typeof r.parent_machine === "string")
    )
      throw fail("smolvm_machine_list_invalid");
    names.add(r.name);
    return { name: r.name, state: r.state, pid: r.pid, parent: r.parent_machine };
  });
}

/** Read one stable process generation, including when it is no longer our VMM. */
async function processSnapshot(
  pid: number,
): Promise<{ readonly start: string; readonly argv: readonly string[] } | undefined> {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (["Z", "X"].includes(fields[0] ?? "") || !/^\d+$/u.test(fields[19] ?? "")) return undefined;
    const argv = (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0");
    // Ordinary non-branchable VMMs deliberately set PR_SET_DUMPABLE=0, so
    // /proc/PID/exe is not readable. Fixed argv plus start ticks bind identity
    // without a ptrace-protected read; reread ticks after inspecting argv.
    const after = await readFile(`/proc/${pid}/stat`, "utf8");
    const finalFields = after.slice(after.lastIndexOf(")") + 2).split(" ");
    if (fields[19] !== finalFields[19] || ["Z", "X"].includes(finalFields[0] ?? ""))
      return undefined;
    return { start: fields[19]!, argv };
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ESRCH"
    )
      return undefined;
    throw error;
  }
}

/** Capturing or using a current VMM requires its complete expected argv shape. */
async function processIdentity(pid: number): Promise<MachineIdentity | undefined> {
  const snapshot = await processSnapshot(pid);
  if (!snapshot) return undefined;
  const { argv, start } = snapshot;
  if (
    argv.length !== 4 ||
    argv[1] !== "_boot-vm" ||
    !path.isAbsolute(argv[2] ?? "") ||
    argv[3] !== ""
  )
    throw fail("smolvm_process_identity_invalid");
  return { pid, start, executable: argv[0]!, bootConfig: argv[2]! };
}

/** Cleanup asks whether the original VMM remains, not whether its PID is occupied. */
async function originalProcessAlive(identity: MachineIdentity): Promise<boolean> {
  const snapshot = await processSnapshot(identity.pid);
  return (
    snapshot !== undefined &&
    snapshot.start === identity.start &&
    snapshot.argv.length === 4 &&
    snapshot.argv[0] === identity.executable &&
    snapshot.argv[1] === "_boot-vm" &&
    snapshot.argv[2] === identity.bootConfig &&
    snapshot.argv[3] === ""
  );
}

function assertOwnedIdentity(cli: SmolvmCli, identity: MachineIdentity): void {
  // Pinned Linux smolvm self_exe_for_spawn deliberately execs /proc/self/exe.
  // The verified CLI launch and its private boot-config path bind the runtime.
  if (
    identity.executable !== "/proc/self/exe" ||
    !identity.bootConfig.startsWith(`${cli.stateDirectory}/`) ||
    path.normalize(identity.bootConfig) !== identity.bootConfig
  )
    throw fail("smolvm_process_identity_invalid");
}

function sameIdentity(a: MachineIdentity, b: MachineIdentity): boolean {
  return (
    a.pid === b.pid &&
    a.start === b.start &&
    a.executable === b.executable &&
    a.bootConfig === b.bootConfig
  );
}

export async function captureMachineIdentity(
  cli: SmolvmCli,
  name: string,
): Promise<MachineIdentity> {
  const record = (await listMachines(cli)).find((r) => r.name === name);
  if (!record || record.pid === null || !["running", "frozen"].includes(record.state))
    throw fail("smolvm_machine_not_running");
  const identity = await processIdentity(record.pid);
  if (!identity) throw fail("smolvm_process_identity_invalid");
  assertOwnedIdentity(cli, identity);
  await assertMachineAlive(identity);
  return identity;
}

export async function assertMachineAlive(identity: MachineIdentity): Promise<void> {
  const current = await processIdentity(identity.pid);
  if (!current || !sameIdentity(current, identity)) throw fail("smolvm_machine_identity_changed");
}

/** No force-kill fallback. Failed/unconfirmed stops preserve state for recovery. */
export async function stopMachine(
  cli: SmolvmCli,
  name: string,
  identity?: MachineIdentity,
): Promise<void> {
  const record = (await listMachines(cli)).find((r) => r.name === name);
  if (!record) {
    if (identity && (await originalProcessAlive(identity)))
      throw fail("smolvm_live_machine_record_missing");
    return;
  }
  let captured = identity;
  if (record.pid !== null) {
    const current = await processIdentity(record.pid);
    if (captured && current && !sameIdentity(current, captured))
      throw fail("smolvm_machine_identity_changed");
    if (!captured && current) {
      assertOwnedIdentity(cli, current);
      captured = current;
    }
  }
  if (captured && record.pid !== null && record.pid !== captured.pid)
    throw fail("smolvm_machine_identity_changed");
  await checkedCommand(cli, ["machine", "stop", "--name", name]);
  if (captured) {
    for (let i = 0; i < 40; i++) {
      if (!(await originalProcessAlive(captured))) break;
      if (i === 39) throw fail("smolvm_stop_unconfirmed");
      await delay(50);
    }
  }
  const stopped = (await listMachines(cli)).find((r) => r.name === name);
  // Upstream does not probe Created records; a failed start may lack a
  // persisted PID. Retaining that state, even after stop exits zero, is intentional.
  if (!stopped || stopped.state !== "stopped" || stopped.pid !== null)
    throw fail("smolvm_stop_unconfirmed");
}

export async function deleteStoppedMachine(cli: SmolvmCli, name: string): Promise<void> {
  const record = (await listMachines(cli)).find((r) => r.name === name);
  if (!record) return;
  if (record.state !== "stopped" || record.pid !== null)
    throw fail("smolvm_delete_requires_stopped_machine");
  await checkedCommand(cli, ["machine", "delete", "--name", name, "--force"]);
  if ((await listMachines(cli)).some((r) => r.name === name))
    throw fail("smolvm_delete_unconfirmed");
}
