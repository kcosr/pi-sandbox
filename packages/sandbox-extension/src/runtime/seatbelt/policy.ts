import { posix } from "node:path";
import {
  assertSeatbeltPath,
  isSeatbeltPathWithin,
  type CanonicalSeatbeltDirectory,
} from "./paths.js";

/** Internal typed profile input; callers use the executor, not raw SBPL. */
export interface SeatbeltPolicy {
  readonly workspace: CanonicalSeatbeltDirectory;
  readonly workspaceWritable: boolean;
  /** Dedicated host-created session home/temp/cache directories, never all /tmp. */
  readonly temporaryDirectories: readonly CanonicalSeatbeltDirectory[];
  /** Access denial, not masking. Only the workspace is restored through ancestors. */
  readonly deniedDirectories: readonly CanonicalSeatbeltDirectory[];
  readonly networkMode: "none" | "host";
}

export interface SeatbeltProfile {
  readonly profile: string;
  /** Supply each entry as its own -D KEY=value argv pair; never use a shell. */
  readonly parameters: Readonly<Record<string, string>>;
}

export const SEATBELT_MAXIMUM_DIRECTORIES = 64;
export const SEATBELT_MAXIMUM_PROFILE_BYTES = 65_536;

const POLICY_KEYS = new Set([
  "workspace",
  "workspaceWritable",
  "temporaryDirectories",
  "deniedDirectories",
  "networkMode",
]);
const SYSTEM_TREES = ["/System", "/usr", "/bin", "/sbin", "/dev"];
const RESERVED_GRANT_ROOTS = new Set(["/Users", "/Volumes", "/Library"]);
const PRIVATE_TEMPORARY_ROOTS = ["/private/tmp", "/private/var/tmp", "/private/var/folders"];
const RESERVED_PRIVATE_GRANT_ROOTS = new Set([
  "/private",
  "/private/var",
  ...PRIVATE_TEMPORARY_ROOTS,
]);

function assertPolicyPath(value: unknown): asserts value is string {
  assertSeatbeltPath(value);
  if (
    value === "/" ||
    SYSTEM_TREES.some((root) => isSeatbeltPathWithin(root, value)) ||
    // These are known aliases, not canonical macOS paths. Other symlinks require
    // the host-side realpath validator; this pure generator never touches disk.
    ["/tmp", "/var", "/etc"].some((root) => isSeatbeltPathWithin(root, value))
  ) {
    throw new Error("seatbelt_path_reserved");
  }
}

function assertGrantPath(value: unknown, writable: boolean): asserts value is string {
  assertPolicyPath(value);
  if (
    RESERVED_GRANT_ROOTS.has(value) ||
    RESERVED_PRIVATE_GRANT_ROOTS.has(value) ||
    (writable &&
      isSeatbeltPathWithin("/private", value) &&
      !PRIVATE_TEMPORARY_ROOTS.some((root) => value.startsWith(`${root}/`)))
  ) {
    throw new Error("seatbelt_path_reserved");
  }
}

/** Internal pure placement ceiling for ordinary workspace and scratch grants. */
export function assertSeatbeltWritableGrantPath(value: unknown): asserts value is string {
  assertGrantPath(value, true);
}

function sortedUnique(
  paths: readonly CanonicalSeatbeltDirectory[],
  validate: (value: unknown) => asserts value is string,
): string[] {
  if (!Array.isArray(paths) || paths.length > SEATBELT_MAXIMUM_DIRECTORIES) {
    throw new Error("seatbelt_directories_invalid");
  }
  const checked: string[] = [];
  for (const candidate of paths as readonly unknown[]) {
    validate(candidate);
    checked.push(candidate);
  }
  return [...new Set(checked)].sort();
}

/**
 * Pure, deterministic SBPL generation from canonical validated directories.
 * No launch, environment inheritance, raw SBPL option, lifecycle or fallback is
 * provided. Runtime ownership and probes belong to the executor.
 */
export function buildSeatbeltProfile(policy: SeatbeltPolicy): SeatbeltProfile {
  if (
    typeof policy !== "object" ||
    policy === null ||
    Array.isArray(policy) ||
    Object.keys(policy).some((key) => !POLICY_KEYS.has(key)) ||
    typeof policy.workspaceWritable !== "boolean" ||
    (policy.networkMode !== "none" && policy.networkMode !== "host")
  ) {
    throw new Error("seatbelt_policy_invalid");
  }
  if (policy.workspaceWritable) assertSeatbeltWritableGrantPath(policy.workspace);
  else assertGrantPath(policy.workspace, false);
  const workspace = policy.workspace;
  // Sensitive canonical /private directories must remain valid read denials;
  // their unsuitability for writable grants must not prevent protecting them.
  const denied = sortedUnique(policy.deniedDirectories, assertPolicyPath);
  const temporary = sortedUnique(policy.temporaryDirectories, assertSeatbeltWritableGrantPath);
  if (denied.includes(workspace)) throw new Error("seatbelt_workspace_denied");

  const overlaps = (left: string, right: string) =>
    isSeatbeltPathWithin(left, right) || isSeatbeltPathWithin(right, left);
  for (const [index, directory] of temporary.entries()) {
    if (
      overlaps(workspace, directory) ||
      denied.some((other) => overlaps(other, directory)) ||
      temporary.slice(0, index).some((other) => overlaps(other, directory))
    ) {
      throw new Error("seatbelt_temporary_directory_overlap");
    }
  }

  // Renaming an allowed ancestor of a denied descendant would move protected
  // contents out of a path-based rule. Pin every such ancestor against unlink/
  // rename, not merely the denied leaf. This does not pin paths against the host.
  // Bound intermediate construction too: a deep protected descendant adds one
  // removal guard per ancestor and must not allocate an unbounded profile first.
  const parameterPaths = new Set<string>();
  let parameterBytes = 0;
  const addParameterPath = (value: string) => {
    if (parameterPaths.has(value)) return;
    parameterBytes += Buffer.byteLength(value) + 16;
    if (parameterBytes > SEATBELT_MAXIMUM_PROFILE_BYTES) {
      throw new Error("seatbelt_profile_too_large");
    }
    parameterPaths.add(value);
  };
  [workspace, ...temporary, ...denied].forEach(addParameterPath);
  const removalGuards = new Set<string>([workspace, ...temporary]);
  for (const directory of denied) {
    if (!isSeatbeltPathWithin(workspace, directory)) continue;
    for (let current = directory; current !== workspace; current = posix.dirname(current)) {
      addParameterPath(current);
      removalGuards.add(current);
    }
  }

  const paths = [...parameterPaths].sort();
  const parameters = Object.fromEntries(paths.map((value, index) => [`P${index}`, value]));
  const keys = new Map(paths.map((value, index) => [value, `P${index}`]));
  const filter = (operation: "subpath" | "literal", value: string) =>
    `(${operation} (param "${keys.get(value)!}"))`;
  const subpath = (value: string) => filter("subpath", value);
  const all = (terms: readonly string[]) =>
    terms.length === 1 ? terms[0]! : `(require-all ${terms.join(" ")})`;

  // Broad host reads, with only the workspace restored inside denied ancestors.
  // A denied descendant is never overridden by that restoration.
  const readExclusions = denied.map((directory) =>
    isSeatbeltPathWithin(directory, workspace)
      ? `(require-any (require-not ${subpath(directory)}) ${subpath(workspace)})`
      : `(require-not ${subpath(directory)})`,
  );
  const workspaceExclusions = denied
    .filter((directory) => isSeatbeltPathWithin(workspace, directory))
    .map((directory) => `(require-not ${subpath(directory)})`);

  const lines = [
    "(version 1)",
    "(deny default)",
    "(allow process-exec process-fork)",
    // Ordinary shells/runtimes must control their own children; host processes
    // remain outside this signal grant.
    "(allow signal (target same-sandbox))",
    "(allow sysctl-read)",
    // Some process-info operations are not covered by deny-default. In
    // particular KERN_PROCARGS exposes same-UID host argv AND environment.
    "(deny process-info*)",
    // Required by Bun's native runtime, restricted to its own process.
    "(allow process-info-pidinfo (target self))",
    '(deny sysctl-read (sysctl-name-prefix "kern.proc"))',
    // Shells and ordinary command tools need a discard sink, not device authority.
    '(allow file-write-data (literal "/dev/null"))',
    readExclusions.length ? `(allow file-read* ${all(readExclusions)})` : "(allow file-read*)",
  ];
  if (policy.workspaceWritable) {
    lines.push(`(allow file-write* ${all([subpath(workspace), ...workspaceExclusions])})`);
  }
  for (const directory of temporary) lines.push(`(allow file-write* ${subpath(directory)})`);
  lines.push(
    `(deny file-write-unlink ${[...removalGuards]
      .sort()
      .map((p) => filter("literal", p))
      .join(" ")})`,
    policy.networkMode === "host" ? "(allow network*)" : "(deny network*)",
    // Fixed in both modes: there is no opt-in to AppleEvents or a Mach service
    // capable of spawning an unrestricted host command/network proxy.
    "(deny appleevent-send mach-lookup mach-register)",
  );
  const profile = `${lines.join("\n")}\n`;
  const bytes =
    Buffer.byteLength(profile) +
    Object.entries(parameters).reduce(
      (total, [key, value]) => total + Buffer.byteLength(`${key}=${value}`) + 1,
      0,
    );
  if (bytes > SEATBELT_MAXIMUM_PROFILE_BYTES) throw new Error("seatbelt_profile_too_large");
  return Object.freeze({ profile, parameters: Object.freeze(parameters) });
}
