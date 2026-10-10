import { randomBytes } from "node:crypto";
import { access, lstat, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { AdmissionQueue } from "../admission.js";
import { SMOLVM_GUEST_COMMAND } from "../guest-command.js";
import {
  SandboxExecutionError,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxExecutionOptions,
} from "../../contracts.js";
import { resolveSmolvmLimits, smolvmRequest, assertGuestPath } from "../request.js";
import { SmolvmCli, createStateEnvironment } from "../cli.js";
import { hostControlPaths } from "../host-control-paths.js";
import { removeStoppedPrivateState } from "../private-state.js";
import { SMOLVM_VERSION, verifySmolvmRuntime } from "../runtime-release.js";
import {
  assertMachineAlive,
  captureMachineIdentity,
  checkedCommand,
  deleteStoppedMachine,
  listMachines,
  stopMachine,
  type MachineIdentity,
} from "../lifecycle.js";
import { serveOciFamily } from "./transport.js";
import { verifyOciRawDiskCapacity } from "./disk-capacity.js";
import type {
  SmolvmOciAttachment,
  SmolvmOciFamily,
  SmolvmOciFamilyOptions,
  SmolvmOciRetainedFamily,
} from "./types.js";
import {
  claimColdRecord,
  fileDigest,
  mountIdentities,
  publishColdRecord,
  readColdRecord,
} from "./retention.js";

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
          "imageArchive",
          "imageSha256",
          "stateDirectory",
          "cwd",
          "networkMode",
          "mounts",
          "resources",
          "limits",
        ].includes(k),
    )
  )
    throw fail();
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

async function validateHostOptions(options: SmolvmOciFamilyOptions): Promise<void> {
  validateOciFamilyOptions(options);
  if (process.platform !== "linux" || process.arch !== "x64")
    throw new Error("smolvm_oci_requires_linux_x64");
  await Promise.all([
    canonical(options.smolvmPath, false),
    canonical(options.imageArchive, false),
    canonical(options.stateDirectory, true),
    access("/dev/kvm", 6),
  ]);
  const stateStat = await lstat(options.stateDirectory);
  if (stateStat.uid !== process.getuid?.() || (stateStat.mode & 0o077) !== 0)
    throw new Error("smolvm_oci_state_directory_not_private");
  if (Buffer.byteLength(options.stateDirectory) > 48)
    throw new Error("smolvm_oci_state_path_too_long");
  const protectedPaths = [
    options.stateDirectory,
    options.imageArchive,
    options.smolvmPath,
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
): Promise<SmolvmOciFamily> {
  options = structuredClone(options);
  await validateHostOptions(options);
  const runtimeFingerprint = await verifySmolvmRuntime(options.smolvmPath);
  const mountFingerprint = await mountIdentities(options);
  const state = await mkdtemp(path.join(options.stateDirectory, "family-"));
  const family = new Family(
    options,
    state,
    new SmolvmCli({ smolvmPath: options.smolvmPath, stateDirectory: state }),
    runtimeFingerprint,
    mountFingerprint,
  );
  try {
    await family.start();
    return family;
  } catch (error) {
    return rejectAfterCleanup(error, () => family.close({ retainState: true }), state);
  }
}

async function rejectAfterCleanup(
  error: unknown,
  cleanup: () => Promise<void>,
  statePath: string,
): Promise<never> {
  try {
    await cleanup();
  } catch (cleanupError) {
    throw new AggregateError(
      [error, cleanupError],
      `smolvm_oci_start_failed; retained state: ${statePath}; use recovery.json for scoped CLI recovery`,
    );
  }
  throw error;
}

/** Cold-start a cleanly retained source on this host. Never resumes RAM. */
export async function reopenSmolvmOciFamily(input: {
  readonly statePath: string;
}): Promise<SmolvmOciFamily> {
  if (!input || Object.keys(input).join(",") !== "statePath") throw fail();
  await canonical(input.statePath, true);
  const stateStat = await lstat(input.statePath);
  if (stateStat.uid !== process.getuid?.() || stateStat.mode & 0o077) throw fail();
  const record = await readColdRecord(input.statePath);
  await validateHostOptions(record.options);
  if (
    path.dirname(input.statePath) !== record.options.stateDirectory ||
    record.cwd !== record.options.cwd ||
    record.imageSha256 !== record.options.imageSha256 ||
    (await verifySmolvmRuntime(record.options.smolvmPath)) !== record.runtimeIdentity ||
    JSON.stringify(await mountIdentities(record.options)) !== JSON.stringify(record.mountIdentities)
  )
    throw new Error("smolvm_oci_cold_binding_changed");
  const cli = new SmolvmCli({
    smolvmPath: record.options.smolvmPath,
    stateDirectory: input.statePath,
  });
  try {
    const records = await listMachines(cli);
    if (
      records.length !== 1 ||
      records[0]?.name !== "candidate" ||
      records[0].state !== "stopped" ||
      records[0].pid !== null ||
      records[0].parent !== null
    )
      throw new Error("smolvm_oci_cold_source_not_stopped");
    await claimColdRecord(input.statePath);
  } catch (error) {
    return rejectAfterCleanup(error, () => cli.dispose(), input.statePath);
  }
  const family = new Family(
    record.options,
    input.statePath,
    cli,
    record.runtimeIdentity,
    record.mountIdentities,
  );
  try {
    await family.start(true);
    return family;
  } catch (error) {
    return rejectAfterCleanup(error, () => family.close({ retainState: true }), input.statePath);
  }
}

class Family implements SmolvmOciFamily {
  readonly sourceId = "candidate";
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
  #stopServer?: () => Promise<void>;
  #closing?: Promise<void>;
  #closed = false;
  #index = 0;
  constructor(
    readonly options: SmolvmOciFamilyOptions,
    readonly statePath: string,
    readonly cli: SmolvmCli,
    readonly runtimeFingerprint: string,
    readonly mountFingerprint: readonly { dev: number; ino: number }[],
  ) {
    this.#limits = ociLimits(options.limits);
    this.#queue = new AdmissionQueue();
  }
  async start(reopen = false): Promise<void> {
    await writeFile(
      path.join(this.statePath, "recovery.json"),
      JSON.stringify({
        version: 1,
        kind: "oci-family",
        runtime: this.options.smolvmPath,
        runtimeVersion: SMOLVM_VERSION,
        runtimeIdentity: this.runtimeFingerprint,
        environment: createStateEnvironment(this.statePath),
        inspect: ["machine", "ls", "--json"],
        cleanup:
          "Stop and delete child leaves before their frozen parents; retain state until every VM is confirmed stopped.",
      }) + "\n",
      { mode: 0o600 },
    );
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
    if (!reopen) await this.command(args);
    await this.command(["machine", "start", "--name", this.sourceId, "--branchable"]);
    const dataDir = (await this.command(["machine", "data-dir", "--name", this.sourceId])).stdout
      .toString()
      .trim();
    if (!inside(this.statePath, dataDir)) throw new Error("smolvm_oci_data_directory_invalid");
    await canonical(dataDir, true);
    await verifyOciRawDiskCapacity(dataDir, r);
    this.#machines.set(this.sourceId, {
      frozen: false,
      token: randomBytes(32).toString("hex"),
      identity: await captureMachineIdentity(this.cli, this.sourceId),
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
    for (const machine of this.#machines.values()) await assertMachineAlive(machine.identity);
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
  async branch(machineId: string, options: { readonly branchable: boolean }): Promise<string> {
    if (
      !options ||
      Object.keys(options).join(",") !== "branchable" ||
      typeof options.branchable !== "boolean"
    )
      throw fail();
    const release = await this.#queue.acquire({ exclusive: true });
    try {
      const source = this.#machines.get(machineId);
      if (!source || this.#closed) throw new SandboxExecutionError("sandbox_closed");
      if (!source.branchable) throw fail();
      if (this.#machines.size >= 16) throw new SandboxExecutionError("sandbox_invalid_request");
      await this.assertAlive();
      const child = `branch-${++this.#index}`;
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
      await closing;
      throw error;
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
      await stopMachine(this.cli, machineId, this.#machines.get(machineId)!.identity);
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
      await deleteStoppedMachine(this.cli, machineId);
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
      if (this.#closed || this.#machines.size !== 1 || !this.#machines.get(this.sourceId)?.frozen)
        throw new SandboxExecutionError("sandbox_invalid_request");
      await this.assertAlive();
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
      const closing = this.close({ retainState: true });
      release();
      await closing;
      const descriptor: SmolvmOciRetainedFamily = {
        version: 1,
        mode: "cold",
        statePath: this.statePath,
        imageSha256: this.options.imageSha256,
        cwd: this.options.cwd,
      };
      await publishColdRecord({
        ...descriptor,
        options: this.options,
        runtimeIdentity: this.runtimeFingerprint,
        mountIdentities: this.mountFingerprint,
      });
      return descriptor;
    } finally {
      release();
    }
  }
  close(options: { readonly retainState?: boolean } = {}): Promise<void> {
    if (!this.#closing) {
      this.#closed = true;
      this.#queue.fail(new SandboxExecutionError("sandbox_closed"));
      this.#closing = this.dispose(options.retainState ?? false);
    }
    return this.#closing;
  }
  private async dispose(retain: boolean): Promise<void> {
    const failures: unknown[] = [];
    // Retire admission first, then stop active CLI calls. A detached VM remains
    // owned by its recorded name until normal shutdown is confirmed.
    try {
      await this.cli.cancelActive();
      // A caller may be between an identity read and a CLI phase. Let that
      // admitted operation unwind before starting lifecycle cleanup itself.
      await this.#queue.idle();
      const remaining = new Map((await listMachines(this.cli)).map((m) => [m.name, m]));
      while (remaining.size) {
        const leaf = [...remaining.values()].find(
          (m) => ![...remaining.values()].some((other) => other.parent === m.name),
        );
        if (!leaf || !/^(?:candidate|branch-[1-9][0-9]*)$/u.test(leaf.name))
          throw new Error("smolvm_oci_cleanup_inventory_invalid");
        await stopMachine(this.cli, leaf.name, this.#machines.get(leaf.name)?.identity);
        // Children must be deleted even when retaining: their backing links
        // otherwise prevent stopping the frozen source. Only source is retained.
        if (leaf.name !== this.sourceId || !retain) await deleteStoppedMachine(this.cli, leaf.name);
        remaining.delete(leaf.name);
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
  }
}
