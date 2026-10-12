import { constants, lstat, open, realpath, rename } from "node:fs/promises";
import path from "node:path";
import { validateMachineIdentity, type MachineIdentity } from "../lifecycle.js";
import {
  validateRegistryIdentity,
  validMachineName,
  type SmolvmRegistryIdentity,
} from "../registry.js";
import { MAX_OCI_DEPTH, validateAncestors, type BorrowedAncestor } from "./ancestry.js";
import type { SmolvmOciFamilyOptions } from "./types.js";

export type OwnedStatus = "intent" | "created" | "running" | "stopped" | "deleted" | "uncertain";
export interface OwnedMachine {
  readonly name: string;
  readonly parent: string | null;
  status: OwnedStatus;
  identity: MachineIdentity | null;
}
export interface FamilyJournal {
  readonly version: 3;
  readonly kind: "oci-family";
  readonly sourceId: string;
  readonly statePath: string;
  readonly runtime: string;
  readonly runtimeVersion: string;
  readonly runtimeIdentity: string;
  readonly hostToolsIdentity?: string;
  readonly registry: SmolvmRegistryIdentity;
  readonly environment: Readonly<Record<string, string>>;
  readonly options: SmolvmOciFamilyOptions;
  readonly mountIdentities: readonly { dev: number; ino: number }[];
  readonly machines: readonly OwnedMachine[];
  readonly borrowedAncestors: readonly BorrowedAncestor[];
}
/** Forget acknowledged deleted leaves, retaining every still-referenced ancestor. */
export function compactOwnedMachines(
  machines: readonly OwnedMachine[],
  sourceId: string,
): OwnedMachine[] {
  const keep = new Set([sourceId]);
  for (const machine of [...machines].reverse()) {
    if (machine.status !== "deleted") keep.add(machine.name);
    if (keep.has(machine.name) && machine.parent !== null) keep.add(machine.parent);
  }
  return machines.filter((machine) => keep.has(machine.name));
}
const invalid = () => new Error("smolvm_oci_journal_invalid");
export async function assertPrivateState(statePath: string): Promise<void> {
  const stat = await lstat(statePath);
  if (
    !path.isAbsolute(statePath) ||
    (await realpath(statePath)) !== statePath ||
    !stat.isDirectory() ||
    stat.uid !== process.getuid?.() ||
    stat.mode & 0o077
  )
    throw invalid();
}
export async function readJournal(statePath: string): Promise<FamilyJournal> {
  await assertPrivateState(statePath);
  const file = await open(
    path.join(statePath, "recovery.json"),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.uid !== process.getuid?.() ||
      stat.mode & 0o077 ||
      stat.size > 65536
    )
      throw invalid();
    const bytes = Buffer.alloc(65537);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > 65536) throw invalid();
    const value = JSON.parse(bytes.subarray(0, length).toString()) as FamilyJournal;
    if (
      !value ||
      Object.keys(value)
        .filter((key) => key !== "hostToolsIdentity")
        .sort()
        .join(",") !==
        "borrowedAncestors,environment,kind,machines,mountIdentities,options,registry,runtime,runtimeIdentity,runtimeVersion,sourceId,statePath,version" ||
      value.version !== 3 ||
      (value.hostToolsIdentity !== undefined &&
        (typeof value.hostToolsIdentity !== "string" ||
          !/^[a-f0-9]{64}$/u.test(value.hostToolsIdentity))) ||
      value.kind !== "oci-family" ||
      value.statePath !== statePath ||
      !validMachineName(value.sourceId) ||
      typeof value.runtime !== "string" ||
      !path.isAbsolute(value.runtime) ||
      !/^[a-f0-9]{64}$/u.test(value.runtimeIdentity) ||
      typeof value.runtimeVersion !== "string" ||
      !value.environment ||
      typeof value.environment !== "object" ||
      Array.isArray(value.environment) ||
      Object.values(value.environment).some((v) => typeof v !== "string") ||
      Object.keys(value.environment).some(
        (k) =>
          ![
            "PATH",
            "LANG",
            "HOME",
            "XDG_DATA_HOME",
            "XDG_CACHE_HOME",
            "XDG_CONFIG_HOME",
            "XDG_STATE_HOME",
            "XDG_RUNTIME_DIR",
            "SMOLVM_CONFIG",
          ].includes(k),
      ) ||
      !Array.isArray(value.mountIdentities) ||
      value.mountIdentities.some(
        (m: { readonly dev: number; readonly ino: number }) =>
          !m ||
          Object.keys(m).sort().join(",") !== "dev,ino" ||
          !Number.isSafeInteger(m.dev) ||
          !Number.isSafeInteger(m.ino),
      ) ||
      !Array.isArray(value.machines) ||
      !value.machines.length ||
      value.machines.length > 4096
    )
      throw invalid();
    validateRegistryIdentity(value.registry);
    validateAncestors(value.borrowedAncestors);
    const sourceParent = value.borrowedAncestors.at(-1)?.identity.name ?? null;
    const ancestorNames = new Set(value.borrowedAncestors.map((a) => a.identity.name));
    const names = new Set<string>();
    const depths = new Map<string, number>();
    const machines: readonly OwnedMachine[] = value.machines;
    for (const machine of machines) {
      if (
        !machine ||
        Object.keys(machine).sort().join(",") !== "identity,name,parent,status" ||
        !validMachineName(machine.name) ||
        names.has(machine.name) ||
        ancestorNames.has(machine.name) ||
        (names.size === 0
          ? machine.name !== value.sourceId || machine.parent !== sourceParent
          : machine.parent === null || !names.has(machine.parent)) ||
        !["intent", "created", "running", "stopped", "deleted", "uncertain"].includes(
          machine.status,
        )
      )
        throw invalid();
      const depth =
        names.size === 0 ? value.borrowedAncestors.length : depths.get(machine.parent!)! + 1;
      if (depth > MAX_OCI_DEPTH) throw invalid();
      depths.set(machine.name, depth);
      names.add(machine.name);
      if (machine.identity !== null) {
        validateMachineIdentity(machine.identity);
        if (machine.identity.name !== machine.name || machine.identity.parent !== machine.parent)
          throw invalid();
      } else if (!["intent", "created", "uncertain"].includes(machine.status)) throw invalid();
    }
    if (machines[0]?.name !== value.sourceId || machines[0].parent !== sourceParent)
      throw invalid();
    return value;
  } finally {
    await file.close();
  }
}
export async function writeJournal(value: FamilyJournal): Promise<void> {
  const bytes = JSON.stringify(value) + "\n";
  if (Buffer.byteLength(bytes) > 65536) throw invalid();
  const temporary = path.join(value.statePath, "recovery.partial");
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(bytes);
    await file.sync();
  } finally {
    await file.close();
  }
  await rename(temporary, path.join(value.statePath, "recovery.json"));
  const directory = await open(value.statePath, "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
