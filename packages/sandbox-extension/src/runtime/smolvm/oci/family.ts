import { randomBytes } from "node:crypto";
import { lstat, mkdtemp, realpath, writeFile, open, unlink } from "node:fs/promises";
import path from "node:path";
import { verifySmolvmCapability } from "../platform.js";
import { validateHostTools, verifyHostTools } from "../host-tools.js";
import { AdmissionQueue } from "../admission.js";
import { SMOLVM_GUEST_COMMAND } from "../guest-command.js";
import {
  SandboxExecutionError,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxExecutionOptions,
} from "../../contracts.js";
import { resolveSmolvmLimits, smolvmRequest, assertGuestPath } from "../request.js";
import { SmolvmCli } from "../cli.js";
import { hostControlPaths } from "../host-control-paths.js";
import { removeStoppedPrivateState } from "../private-state.js";
import { SMOLVM_VERSION, verifySmolvmRuntime } from "../runtime-release.js";
import {
  assertMachineAlive,
  assertMachineIdentity,
  captureMachineIdentity,
  checkedCommand,
  deleteStoppedMachine,
  listMachines,
  stopMachine,
  type MachineIdentity,
} from "../lifecycle.js";
import { serveOciFamily } from "./transport.js";
import { verifyOciDiskCapacity } from "./disk-capacity.js";
import { TerminalSessions, validateTerminalOptions } from "./terminals.js";
import type {
  SmolvmOciAttachment,
  SmolvmOciFamily,
  SmolvmOciFamilyOptions,
  SmolvmOciFamilyHooks,
  SmolvmOciRetainedFamily,
  SmolvmOciTerminal,
  SmolvmOciTerminalOptions,
} from "./types.js";
import {
  claimColdRecord,
  fileDigest,
  mountIdentities,
  publishColdRecord,
  readColdRecord,
} from "./retention.js";

import {
  createSmolvmEnvironment,
  registryIdentity,
  uniqueMachineName,
  validateNamePrefix,
  validateSmolvmSocketPaths,
  type SmolvmRegistryIdentity,
} from "../registry.js";
import {
  assertPrivateState,
  compactOwnedMachines,
  readJournal,
  writeJournal,
  type FamilyJournal,
  type OwnedMachine,
} from "./journal.js";

const fail = () => new SandboxExecutionError("sandbox_invalid_request");
const inside = (parent: string, child: string) =>
  parent === "/" || child === parent || child.startsWith(parent + "/");
async function canonical(value: string, directory: boolean): Promise<void> {
  assertGuestPath(value);
  if ((await realpath(value)) !== value) throw fail();
  const st = await lstat(value);
  if (directory ? !st.isDirectory() : !st.isFile()) throw fail();
}
export function validateOciFamilyOptions(value: SmolvmOciFamilyOptions): void {
  if (
    !value ||
    typeof value !== "object" ||
    Object.keys(value).some(
      (k) =>
        ![
          "smolvmPath",
          "namePrefix",
          "imageArchive",
          "imageSha256",
          "stateDirectory",
          "cwd",
          "networkMode",
          "mounts",
          "resources",
          "limits",
          "e2fsprogsDirectory",
        ].includes(k),
    )
  )
    throw fail();
  validateHostTools(value);
  if (value.namePrefix !== undefined) validateNamePrefix(value.namePrefix);
  for (const p of [value.smolvmPath, value.imageArchive, value.stateDirectory, value.cwd])
    assertGuestPath(p);
  if (!/^[a-f0-9]{64}$/u.test(value.imageSha256) || !["none", "host"].includes(value.networkMode))
    throw fail();
  if (
    !value.resources ||
    Object.keys(value.resources).sort().join(",") !== "cpus,memoryMiB,overlayGiB,storageGiB"
  )
    throw fail();
  const r = value.resources;
  for (const [v, max] of [
    [r.cpus, 32],
    [r.memoryMiB, 65536],
    [r.storageGiB, 256],
    [r.overlayGiB, 256],
  ])
    if (!Number.isSafeInteger(v) || v! <= 0 || v! > max!) throw fail();
  if (r.memoryMiB < 256) throw fail();
  if (value.mounts !== undefined && (!Array.isArray(value.mounts) || value.mounts.length > 16))
    throw fail();
  const guest: string[] = [];
  for (const m of (value.mounts ?? []) as NonNullable<SmolvmOciFamilyOptions["mounts"]>) {
    if (
      !m ||
      Object.keys(m).sort().join(",") !== "guestPath,hostPath,readOnly" ||
      m.readOnly !== true
    )
      throw fail();
    assertGuestPath(m.hostPath);
    assertGuestPath(m.guestPath);
    if (
      m.guestPath === "/" ||
      ["/proc", "/sys", "/dev", "/run", "/etc", "/usr", "/bin", "/sbin", "/lib", "/lib64"].some(
        (p) => inside(p, m.guestPath) || inside(m.guestPath, p),
      ) ||
      guest.some((p) => inside(p, m.guestPath) || inside(m.guestPath, p))
    )
      throw fail();
    guest.push(m.guestPath);
  }
  ociLimits(value.limits);
}
function ociLimits(limits: SmolvmOciFamilyOptions["limits"]) {
  const resolved = resolveSmolvmLimits({
    maximumInputBytes: 1048576,
    maximumArgumentBytes: 65536,
    ...limits,
  });
  if (limits && Object.keys(limits).some((key) => !(key in resolved))) throw fail();
  if (
    resolved.maximumInputBytes > 1048576 ||
    resolved.maximumArgumentBytes > 65536 ||
    resolved.maximumOutputBytes > 64 * 1048576 ||
    resolved.maximumTimeoutMs > 600000
  )
    throw fail();
  return resolved;
}

async function validateHostOptions(
  options: SmolvmOciFamilyOptions,
  registry: SmolvmRegistryIdentity,
  requireKvm = true,
): Promise<void> {
  validateOciFamilyOptions(options);
  await Promise.all([
    canonical(options.smolvmPath, false),
    canonical(options.imageArchive, false),
    canonical(options.stateDirectory, true),
    ...(requireKvm || process.platform === "darwin" ? [verifySmolvmCapability()] : []),
  ]);
  const stateStat = await lstat(options.stateDirectory);
  if (stateStat.uid !== process.getuid?.() || (stateStat.mode & 0o077) !== 0)
    throw new Error("smolvm_oci_state_directory_not_private");
  if (Buffer.byteLength(path.join(options.stateDirectory, "family-XXXXXX/control.sock")) > 100)
    throw new Error("smolvm_oci_state_path_too_long");
  const protectedPaths = [
    options.stateDirectory,
    registry.dataDirectory,
    registry.cacheDirectory,
    registry.configFile,
    options.imageArchive,
    path.dirname(options.smolvmPath),
    ...(await hostControlPaths()),
  ];
  for (const mount of options.mounts ?? []) {
    await canonical(mount.hostPath, true);
    if (protectedPaths.some((p) => inside(mount.hostPath, p) || inside(p, mount.hostPath)))
      throw new Error("smolvm_oci_protected_mount");
  }
  if ((await fileDigest(options.imageArchive)) !== options.imageSha256)
    throw new Error("smolvm_oci_image_digest_mismatch");
}
export async function createSmolvmOciFamily(
  options: SmolvmOciFamilyOptions,
  hooks: SmolvmOciFamilyHooks = {},
): Promise<SmolvmOciFamily> {
  options = structuredClone(options);
  if (
    !hooks ||
    Object.keys(hooks).some((key) => key !== "onPrepared") ||
    (hooks.onPrepared !== undefined && typeof hooks.onPrepared !== "function")
  )
    throw fail();
  const environment = createSmolvmEnvironment(options.e2fsprogsDirectory);
  validateSmolvmSocketPaths(environment);
  const registry = await registryIdentity(environment);
  await validateHostOptions(options, registry);
  const hostToolsIdentity = await verifyHostTools(
    options,
    (options.mounts ?? []).map((m) => m.hostPath),
  );
  const runtimeFingerprint = await verifySmolvmRuntime(options.smolvmPath);
  const mountFingerprint = await mountIdentities(options);
  const state = await mkdtemp(path.join(options.stateDirectory, "family-"));
  const sourceId = uniqueMachineName(options.namePrefix);
  await claimController(state);
  const family = new Family(
    options,
    state,
    new SmolvmCli({
      smolvmPath: options.smolvmPath,
      stateDirectory: state,
      nativeEnvironment: environment,
    }),
    runtimeFingerprint,
    mountFingerprint,
    sourceId,
    registry,
    hostToolsIdentity,
  );
  let nativeStarted = false;
  try {
    await family.persist();
    await hooks.onPrepared?.({ statePath: state, sourceId });
    nativeStarted = true;
    await family.start();
    return family;
  } catch (error) {
    return rejectAfterCleanup(
      error,
      nativeStarted
        ? () => family.close({ retainState: true })
        : async () => {
            await family.cli.dispose();
            await removeStoppedPrivateState(state);
          },
      state,
    );
  }
}

async function rejectAfterCleanup(
  error: unknown,
  cleanup: () => Promise<unknown>,
  statePath: string,
  operation = "start",
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      `smolvm_oci_${operation}_failed; retained state: ${statePath}; use recovery.json for scoped CLI recovery`,
    );
  }
  throw error;
}
const claimController = async (statePath: string) => {
  const claim = await open(path.join(statePath, "controller.claim"), "wx", 0o600);
  await claim.close();
};
const releaseController = (statePath: string) => unlink(path.join(statePath, "controller.claim"));
async function disposeCliClaim(cli: SmolvmCli, statePath: string, claimed: boolean): Promise<void> {
  const failures: unknown[] = [];
  try {
    await cli.dispose();
  } catch (error) {
    failures.push(error);
  }
  if (claimed) {
    try {
      await releaseController(statePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(error);
    }
  }
  if (failures.length) throw new AggregateError(failures, "smolvm_oci_claim_cleanup_failed");
}

async function loadBoundJournal(statePath: string): Promise<FamilyJournal> {
  const journal = await readJournal(statePath);
  validateOciFamilyOptions(journal.options);
  const environment = createSmolvmEnvironment(journal.options.e2fsprogsDirectory);
  validateSmolvmSocketPaths(environment);
  const registry = await registryIdentity(environment);
  if (
    journal.runtimeVersion !== SMOLVM_VERSION ||
    journal.runtime !== journal.options.smolvmPath ||
    path.dirname(statePath) !== journal.options.stateDirectory ||
    JSON.stringify(environment) !== JSON.stringify(journal.environment) ||
    JSON.stringify(registry) !== JSON.stringify(journal.registry)
  )
    throw new Error("smolvm_oci_registry_binding_changed");
  return journal;
}
export async function readSmolvmOciFamily(input: { readonly statePath: string }) {
  if (!input || Object.keys(input).join(",") !== "statePath") throw fail();
  const record = await loadBoundJournal(input.statePath);
  return {
    version: 2 as const,
    sourceId: record.sourceId,
    statePath: record.statePath,
    runtime: record.runtime,
    registry: record.registry,
    environment: record.environment,
    machines: record.machines.map(({ name, parent, status }) => ({ name, parent, status })),
  };
}
async function validateRuntimeBinding(record: FamilyJournal): Promise<void> {
  await canonical(record.runtime, false);
  if ((await verifySmolvmRuntime(record.runtime)) !== record.runtimeIdentity)
    throw new Error("smolvm_oci_runtime_binding_changed");
}
async function validateRetainedBinding(record: FamilyJournal): Promise<void> {
  await validateHostOptions(record.options, record.registry, false);
  await validateRuntimeBinding(record);
  const hostToolsIdentity = await verifyHostTools(
    record.options,
    (record.options.mounts ?? []).map((m) => m.hostPath),
  );
  if (hostToolsIdentity !== record.hostToolsIdentity)
    throw new Error("smolvm_oci_host_tools_binding_changed");
  if (
    JSON.stringify(await mountIdentities(record.options)) !== JSON.stringify(record.mountIdentities)
  )
    throw new Error("smolvm_oci_cold_binding_changed");
}

/** Cold boot a stopped original. Foreign registry machines are irrelevant. */
export async function reopenSmolvmOciFamily(input: {
  readonly statePath: string;
}): Promise<SmolvmOciFamily> {
  if (!input || Object.keys(input).join(",") !== "statePath") throw fail();
  await assertPrivateState(input.statePath);
  const journal = await loadBoundJournal(input.statePath);
  const record = await readColdRecord(input.statePath);
  await validateRetainedBinding(journal);
  if (
    record.sourceId !== journal.sourceId ||
    record.cwd !== journal.options.cwd ||
    record.imageSha256 !== journal.options.imageSha256 ||
    record.runtimeIdentity !== journal.runtimeIdentity ||
    record.hostToolsIdentity !== journal.hostToolsIdentity ||
    JSON.stringify(record.registry) !== JSON.stringify(journal.registry) ||
    JSON.stringify(record.options) !== JSON.stringify(journal.options) ||
    JSON.stringify(record.mountIdentities) !== JSON.stringify(journal.mountIdentities)
  )
    throw new Error("smolvm_oci_cold_binding_changed");
  const source = journal.machines.find((m) => m.name === journal.sourceId);
  if (
    !source?.identity ||
    source.status !== "stopped" ||
    journal.machines.some((m) => m.name !== journal.sourceId && m.status !== "deleted") ||
    JSON.stringify(source.identity) !== JSON.stringify(record.sourceIdentity)
  )
    throw new Error("smolvm_oci_cold_source_not_stopped");
  const cli = new SmolvmCli({
    smolvmPath: journal.runtime,
    stateDirectory: input.statePath,
    nativeEnvironment: journal.environment,
  });
  let claimed = false;
  try {
    const target = await assertMachineIdentity(cli, source.identity);
    if (!target || target.state !== "stopped" || target.pid !== null || target.parent !== null)
      throw new Error("smolvm_oci_cold_source_not_stopped");
    await claimController(input.statePath);
    claimed = true;
    await claimColdRecord(input.statePath);
  } catch (error) {
    return rejectAfterCleanup(
      error,
      () => disposeCliClaim(cli, input.statePath, claimed),
      input.statePath,
    );
  }
  const family = new Family(
    journal.options,
    input.statePath,
    cli,
    journal.runtimeIdentity,
    journal.mountIdentities,
    journal.sourceId,
    journal.registry,
    journal.hostToolsIdentity,
    journal.machines,
  );
  try {
    await family.start(true);
    return family;
  } catch (error) {
    return rejectAfterCleanup(error, () => family.close({ retainState: true }), input.statePath);
  }
}

/** Delete only recorded stopped originals/descendants, through native smolvm. */
export async function deleteSmolvmOciFamily(input: { readonly statePath: string }): Promise<void> {
  if (!input || Object.keys(input).join(",") !== "statePath") throw fail();
  let journal = await loadBoundJournal(input.statePath);
  // Deletion needs the trusted runtime and exact native identities, but does not
  // boot a guest or consume its original image archive/read-only input mounts.
  await validateRuntimeBinding(journal);
  if (journal.machines.some((m) => !["stopped", "deleted"].includes(m.status)))
    throw new Error("smolvm_oci_cleanup_uncertain");
  const cli = new SmolvmCli({
    smolvmPath: journal.runtime,
    stateDirectory: input.statePath,
    nativeEnvironment: journal.environment,
  });
  let claimed = false;
  try {
    await claimController(input.statePath);
    claimed = true;
    journal = await loadBoundJournal(input.statePath);
    for (const machine of [...journal.machines].reverse()) {
      if (machine.status === "deleted") continue;
      if (machine.status !== "stopped" || !machine.identity)
        throw new Error("smolvm_oci_cleanup_uncertain");
      await deleteStoppedMachine(cli, machine.name, machine.identity);
      machine.status = "deleted";
      journal = { ...journal, machines: compactOwnedMachines(journal.machines, journal.sourceId) };
      await writeJournal(journal);
    }
    await cli.dispose();
    await removeStoppedPrivateState(input.statePath);
  } catch (error) {
    return rejectAfterCleanup(
      error,
      () => disposeCliClaim(cli, input.statePath, claimed),
      input.statePath,
    );
  }
}

class Family implements SmolvmOciFamily {
  readonly #inventory = new Map<string, OwnedMachine>();
  readonly #machines = new Map<
    string,
    {
      frozen: boolean;
      token: string;
      parent?: string;
      identity: MachineIdentity;
      branchable: boolean;
    }
  >();
  readonly #limits;
  readonly #queue;
  readonly #terminals = new TerminalSessions();
  #stopServer?: () => Promise<void>;
  #closing?: Promise<{ readonly retained: boolean }>;
  #sealing = false;
  #closed = false;
  constructor(
    readonly options: SmolvmOciFamilyOptions,
    readonly statePath: string,
    readonly cli: SmolvmCli,
    readonly runtimeFingerprint: string,
    readonly mountFingerprint: readonly { dev: number; ino: number }[],
    readonly sourceId: string,
    readonly registry: SmolvmRegistryIdentity,
    readonly hostToolsIdentity?: string,
    inventory?: readonly OwnedMachine[],
  ) {
    for (const entry of inventory ?? [
      { name: sourceId, parent: null, status: "intent", identity: null },
    ])
      this.#inventory.set(entry.name, structuredClone(entry));
    this.#limits = ociLimits(options.limits);
    this.#queue = new AdmissionQueue();
  }
  async persist(): Promise<void> {
    const machines = compactOwnedMachines([...this.#inventory.values()], this.sourceId);
    await writeJournal({
      version: 2,
      kind: "oci-family",
      sourceId: this.sourceId,
      statePath: this.statePath,
      runtime: this.options.smolvmPath,
      runtimeVersion: SMOLVM_VERSION,
      runtimeIdentity: this.runtimeFingerprint,
      registry: this.registry,
      environment: this.cli.environment,
      options: this.options,
      mountIdentities: this.mountFingerprint,
      ...(this.hostToolsIdentity ? { hostToolsIdentity: this.hostToolsIdentity } : {}),
      machines,
    });
    const retained = new Set(machines.map((machine) => machine.name));
    for (const name of this.#inventory.keys())
      if (!retained.has(name)) this.#inventory.delete(name);
  }
  async start(reopen = false): Promise<void> {
    const r = this.options.resources;
    const args: [string, ...string[]] = [
      "machine",
      "create",
      "--name",
      this.sourceId,
      "--image",
      this.options.imageArchive,
      "--cpus",
      String(r.cpus),
      "--mem",
      String(r.memoryMiB),
      "--storage",
      String(r.storageGiB),
      "--overlay",
      String(r.overlayGiB),
    ];
    if (this.options.networkMode === "host") args.push("--net");
    for (const m of this.options.mounts ?? []) args.push("-v", `${m.hostPath}:${m.guestPath}:ro`);
    args.push("--", "/bin/sleep", "infinity");
    const owned = this.#inventory.get(this.sourceId)!;
    if (!reopen) {
      // A nonzero create may be a collision. Never adopt its name for cleanup.
      owned.status = "uncertain";
      await this.persist();
      await this.command(args);
      owned.status = "created";
      await this.persist();
      owned.identity = await captureMachineIdentity(this.cli, this.sourceId, false);
      if (owned.identity.parent !== null) throw new Error("smolvm_oci_source_identity_invalid");
    }
    owned.status = "uncertain";
    await this.persist();
    await this.command(["machine", "start", "--name", this.sourceId, "--branchable"]);
    if (owned.identity && !(await assertMachineIdentity(this.cli, owned.identity)))
      throw new Error("smolvm_oci_machine_record_missing");
    owned.identity = await captureMachineIdentity(this.cli, this.sourceId);
    owned.status = "running";
    await this.persist();
    const dataDir = owned.identity.dataDirectory;
    if (!dataDir) throw new Error("smolvm_oci_data_directory_invalid");
    await verifyOciDiskCapacity(dataDir, r);
    this.#machines.set(this.sourceId, {
      frozen: false,
      token: randomBytes(32).toString("hex"),
      identity: owned.identity,
      branchable: true,
    });
    const init = await this.execute(this.sourceId, {
      argv: [
        "/usr/bin/node",
        "-e",
        "require('node:fs').mkdirSync(process.argv[1],{recursive:true});process.stdout.write(process.version)",
        this.options.cwd,
      ],
      cwd: "/",
    });
    if (init.exitCode !== 0) throw new Error("smolvm_oci_guest_node_unavailable");
    await writeFile(
      path.join(this.statePath, "family.json"),
      JSON.stringify({
        version: 1,
        imageSha256: this.options.imageSha256,
        networkMode: this.options.networkMode,
        mounts: this.options.mounts ?? [],
        resources: r,
        retention: "forensic-only",
      }) + "\n",
      { mode: 0o600 },
    );
    this.#stopServer = await serveOciFamily(path.join(this.statePath, "control.sock"), this);
  }
  private async command(argv: readonly [string, ...string[]]): Promise<SandboxCommandResult> {
    if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
    return checkedCommand(this.cli, argv);
  }
  private async assertAlive(): Promise<void> {
    for (const machine of this.#machines.values())
      await assertMachineAlive(this.cli, machine.identity);
  }
  attachment(machineId: string): SmolvmOciAttachment {
    const machine = this.#machines.get(machineId);
    if (!machine || machine.frozen || this.#closed)
      throw new SandboxExecutionError("sandbox_closed");
    return {
      version: 1,
      socketPath: path.join(this.statePath, "control.sock"),
      token: machine.token,
      machineId,
      cwd: this.options.cwd,
      home: "/root",
    };
  }
  async execute(
    machineId: string,
    request: SandboxCommandRequest,
    options: SandboxExecutionOptions = {},
  ): Promise<SandboxCommandResult> {
    this.#queue.assertAvailable(options);
    const parsed = smolvmRequest(request, this.#limits, this.options.cwd);
    const deadline = performance.now() + parsed.timeoutMs;
    const payload = Buffer.from(
      JSON.stringify({ argv: parsed.argv, cwd: parsed.cwd, environment: parsed.environment }),
    ).toString("base64");
    // Linux also limits a single argv item. Escaped JSON may expand otherwise
    // valid raw arguments; reject before admitting or launching a command.
    if (payload.length > 98304) throw new SandboxExecutionError("sandbox_invalid_request");
    const release = await this.#queue.acquire({ ...options, deadline });
    try {
      const machine = this.#machines.get(machineId);
      if (!machine || machine.frozen || this.#closed)
        throw new SandboxExecutionError("sandbox_closed");
      await this.assertAlive();
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
      const timeoutMs = Math.ceil(deadline - performance.now());
      if (timeoutMs <= 0) throw new SandboxExecutionError("sandbox_timeout");
      const result = await this.cli.run(
        {
          argv: [
            "machine",
            "exec",
            "--name",
            machineId,
            "--interactive",
            "--",
            "/usr/bin/node",
            "-e",
            SMOLVM_GUEST_COMMAND,
            payload,
          ],
          stdin: parsed.stdin,
          timeoutMs,
          maxOutputBytes: parsed.maxOutputBytes,
        },
        options,
      );
      // Guest signals are converted to numeric exits by the fixed guest wrapper.
      // A host CLI signal means transport/lifecycle failure, not tool completion.
      if (result.signal !== null) throw new SandboxExecutionError("sandbox_process_failed");
      await this.assertAlive();
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
      if (options.signal?.aborted) throw new SandboxExecutionError("sandbox_aborted");
      if (performance.now() >= deadline) throw new SandboxExecutionError("sandbox_timeout");
      return result;
    } catch (error) {
      if (
        error instanceof SandboxExecutionError &&
        error.code === "sandbox_closed" &&
        !this.#closed
      )
        throw error;
      const closing = this.close({ retainState: true });
      release();
      await closing;
      throw error;
    } finally {
      release();
    }
  }
  async openTerminal(
    machineId: string,
    options: SmolvmOciTerminalOptions,
  ): Promise<SmolvmOciTerminal> {
    validateTerminalOptions(options);
    options = { ...options };
    const release = await this.#queue.acquire(options);
    try {
      const machine = this.#machines.get(machineId);
      if (!machine || machine.frozen || this.#closed)
        throw new SandboxExecutionError("sandbox_closed");
      try {
        await this.assertAlive();
      } catch (error) {
        // A dead or replaced VM is a family failure, not a scoped terminal failure.
        const closing = this.close({ retainState: true });
        release();
        await closing;
        throw error;
      }
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
      const readyMarker = `\u001b]777;smolvm-terminal-ready;${randomBytes(24).toString("hex")}\u0007`;
      const terminal = await this.#terminals.open(
        machineId,
        {
          argv: [
            this.options.smolvmPath,
            "machine",
            "exec",
            "--name",
            machineId,
            "--interactive",
            "--tty",
            "--workdir",
            this.options.cwd,
            "--user",
            "0",
            "--env",
            `TERM=${options.terminalType}`,
            "--",
            "/bin/bash",
            "--noprofile",
            "--norc",
            "-c",
            'printf %s "$1"; exec /bin/bash -i',
            "terminal",
            readyMarker,
          ],
          cwd: this.statePath,
          environment: { ...this.cli.environment, TERM: options.terminalType },
          columns: options.columns,
          rows: options.rows,
          readyMarker,
        },
        options,
      );
      if (this.#closed) {
        await terminal.close();
        throw new SandboxExecutionError("sandbox_closed");
      }
      return terminal;
    } finally {
      release();
    }
  }
  async branch(
    machineId: string,
    options: { readonly branchable: boolean; readonly namePrefix?: string },
  ): Promise<string> {
    if (
      !options ||
      Object.keys(options).some((key) => !["branchable", "namePrefix"].includes(key)) ||
      typeof options.branchable !== "boolean"
    )
      throw fail();
    if (options.namePrefix !== undefined) validateNamePrefix(options.namePrefix);
    const release = await this.#queue.acquire({ exclusive: true });
    try {
      const source = this.#machines.get(machineId);
      if (!source || this.#closed) throw new SandboxExecutionError("sandbox_closed");
      if (!source.branchable) throw fail();
      if (this.#machines.size >= 16) throw new SandboxExecutionError("sandbox_invalid_request");
      await this.#terminals.waitFor(machineId);
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
      await this.assertAlive();
      const child = uniqueMachineName(options.namePrefix ?? this.options.namePrefix);
      if ((await listMachines(this.cli)).some((m) => m.name === child))
        throw new Error("smolvm_oci_machine_name_collision");
      const owned: OwnedMachine = {
        name: child,
        parent: machineId,
        status: "uncertain",
        identity: null,
      };
      this.#inventory.set(child, owned);
      await this.persist();
      await this.command([
        "machine",
        "branch",
        "--from",
        machineId,
        "--name",
        child,
        "--freeze-source",
        ...(options.branchable ? ["--branchable"] : []),
      ]);
      source.frozen = true;
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
      const identity = await captureMachineIdentity(this.cli, child);
      if (identity.parent !== machineId) throw new Error("smolvm_oci_branch_identity_invalid");
      owned.identity = identity;
      owned.status = "running";
      await this.persist();
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
      this.#machines.set(child, {
        frozen: false,
        token: randomBytes(32).toString("hex"),
        parent: machineId,
        identity,
        branchable: options.branchable,
      });
      return child;
    } catch (error) {
      if (
        error instanceof SandboxExecutionError &&
        (error.code === "sandbox_invalid_request" ||
          (error.code === "sandbox_closed" && !this.#closed))
      )
        throw error;
      const closing = this.close({ retainState: true });
      release();
      return rejectAfterCleanup(error, () => closing, this.statePath, "branch");
    } finally {
      release();
    }
  }
  async removeMachine(machineId: string): Promise<void> {
    const release = await this.#queue.acquire({ exclusive: true });
    try {
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
      if (
        machineId === this.sourceId ||
        !this.#machines.has(machineId) ||
        [...this.#machines.values()].some((m) => m.parent === machineId)
      )
        throw new SandboxExecutionError("sandbox_invalid_request");
      await this.#terminals.waitFor(machineId);
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
      await stopMachine(this.cli, machineId, this.#machines.get(machineId)!.identity);
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
      const owned = this.#inventory.get(machineId)!;
      owned.status = "stopped";
      await this.persist();
      await deleteStoppedMachine(this.cli, machineId, this.#machines.get(machineId)!.identity);
      owned.status = "deleted";
      await this.persist();
      this.#machines.delete(machineId);
      await this.assertAlive();
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
    } catch (error) {
      if (error instanceof SandboxExecutionError && error.code === "sandbox_invalid_request")
        throw error;
      const closing = this.close({ retainState: true });
      release();
      await closing;
      throw error;
    } finally {
      release();
    }
  }
  async retainForColdReopen(): Promise<SmolvmOciRetainedFamily> {
    const release = await this.#queue.acquire({ exclusive: true });
    try {
      if (this.#closed || this.#machines.size !== 1 || !this.#machines.has(this.sourceId))
        throw new SandboxExecutionError("sandbox_invalid_request");
      await this.#terminals.waitFor();
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
      await this.assertAlive();
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
      this.#sealing = true;
      const closing = this.close({ retainState: true });
      release();
      await closing;
      const descriptor: SmolvmOciRetainedFamily = {
        version: 2,
        sourceId: this.sourceId,
        registry: this.registry,
        mode: "cold",
        statePath: this.statePath,
        imageSha256: this.options.imageSha256,
        cwd: this.options.cwd,
      };
      await publishColdRecord({
        ...descriptor,
        options: this.options,
        sourceIdentity: this.#inventory.get(this.sourceId)!.identity!,
        runtimeIdentity: this.runtimeFingerprint,
        mountIdentities: this.mountFingerprint,
        ...(this.hostToolsIdentity ? { hostToolsIdentity: this.hostToolsIdentity } : {}),
      });
      await releaseController(this.statePath);
      return descriptor;
    } finally {
      release();
    }
  }
  close(options: { readonly retainState?: boolean } = {}): Promise<{ readonly retained: boolean }> {
    if (!this.#closing) {
      this.#closed = true;
      this.#queue.fail(new SandboxExecutionError("sandbox_closed"));
      this.#closing = this.dispose(options.retainState ?? false);
    }
    return this.#closing;
  }
  private async dispose(retain: boolean): Promise<{ readonly retained: boolean }> {
    const failures: unknown[] = [];
    try {
      await this.#terminals.closeAll();
    } catch (cause) {
      failures.push(cause);
    }
    // Retire admission first, then stop active CLI calls. A detached VM remains
    // owned by its recorded name until normal shutdown is confirmed.
    try {
      await this.cli.cancelActive();
      // A caller may be between an identity read and a CLI phase. Let that
      // admitted operation unwind before starting lifecycle cleanup itself.
      await this.#queue.idle();
      // Iterate only journal-owned identities, never the shared registry inventory.
      for (const owned of [...this.#inventory.values()].reverse()) {
        if (owned.status === "deleted") continue;
        try {
          if (!owned.identity || !["running", "stopped"].includes(owned.status))
            throw new Error(`smolvm_oci_cleanup_uncertain: ${owned.name}`);
          if (
            [...this.#inventory.values()].some(
              (child) => child.parent === owned.name && child.status !== "deleted",
            )
          )
            throw new Error(`smolvm_oci_cleanup_dependencies_pending: ${owned.name}`);
          await stopMachine(this.cli, owned.name, owned.identity);
          owned.status = "stopped";
          await this.persist();
          if (owned.name !== this.sourceId || !retain) {
            await deleteStoppedMachine(this.cli, owned.name, owned.identity);
            owned.status = "deleted";
            await this.persist();
          }
        } catch (cause) {
          failures.push(cause);
        }
      }
    } catch (cause) {
      failures.push(cause);
    }
    // Attempt both finalizers even if VM cleanup or the first finalizer fails.
    // Keep every cause and the recovery location instead of replacing one error.
    for (const cleanup of [() => this.#stopServer?.(), () => this.cli.dispose()]) {
      try {
        await cleanup();
      } catch (cause) {
        failures.push(cause);
      }
    }
    if (failures.length)
      throw new AggregateError(
        failures,
        `smolvm_oci_cleanup_unconfirmed: state retained at ${this.statePath}; use recovery.json for scoped CLI recovery`,
      );
    if (!retain) await removeStoppedPrivateState(this.statePath);
    else if (!this.#sealing) await releaseController(this.statePath);
    return { retained: retain };
  }
}
