import type { SmolvmCli } from "../cli.js";
import {
  assertMachineIdentity,
  checkedCommand,
  listMachines,
  validateMachineIdentity,
  type MachineIdentity,
} from "../lifecycle.js";

/** Native identities, never authority to stop or delete these machines. */
export interface BorrowedAncestor {
  readonly identity: MachineIdentity;
  readonly image: string | null;
}
export const MAX_OCI_DEPTH = 32;
const invalid = () => new Error("smolvm_oci_ancestor_binding_invalid");

export function validateAncestors(value: unknown): asserts value is readonly BorrowedAncestor[] {
  if (!Array.isArray(value) || value.length > MAX_OCI_DEPTH) throw invalid();
  const names = new Set<string>();
  let parent: string | null = null;
  for (const item of value as unknown[]) {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw invalid();
    const ancestor = item as Record<string, unknown>;
    if (
      !ancestor ||
      Object.keys(ancestor).sort().join(",") !== "identity,image" ||
      !(ancestor.image === null || typeof ancestor.image === "string")
    )
      throw invalid();
    validateMachineIdentity(ancestor.identity);
    if (
      ancestor.identity.parent !== parent ||
      ancestor.identity.dataDirectory === null ||
      names.has(ancestor.identity.name)
    )
      throw invalid();
    parent = ancestor.identity.name;
    names.add(ancestor.identity.name);
  }
}

export async function captureAncestor(
  cli: SmolvmCli,
  identity: MachineIdentity,
): Promise<BorrowedAncestor> {
  if (!(await assertMachineIdentity(cli, identity))) throw invalid();
  const record: unknown = JSON.parse(
    (
      await checkedCommand(cli, ["machine", "status", "--name", identity.name, "--json"])
    ).stdout.toString(),
  );
  if (!record || typeof record !== "object") throw invalid();
  const r = record as Record<string, unknown>;
  if (
    r.name !== identity.name ||
    r.created_at !== identity.createdAt ||
    r.parent_machine !== identity.parent ||
    !(r.image === null || typeof r.image === "string")
  )
    throw invalid();
  return { identity: structuredClone(identity), image: r.image };
}

export async function assertAncestors(cli: SmolvmCli, ancestors: readonly BorrowedAncestor[]) {
  validateAncestors(ancestors);
  for (const ancestor of ancestors) {
    if ((await captureAncestor(cli, ancestor.identity)).image !== ancestor.image) throw invalid();
  }
}

/** Includes dependents owned by other family controllers and native CLI users. */
export async function assertNoDependents(cli: SmolvmCli, name: string): Promise<void> {
  if ((await listMachines(cli)).some((record) => record.parent === name))
    throw new Error(`smolvm_oci_dependencies_pending: ${name}`);
}
