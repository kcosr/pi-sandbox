import { constants } from "node:fs";
import { access, lstat, mkdtemp, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  SandboxExecutionError,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxExecutionOptions,
  type SandboxExecutor,
} from "../contracts.js";
import { LINUX_TOOL_COMMANDS, REQUIRED_SANDBOX_EXECUTABLES } from "../tool-commands.js";
import { AdmissionQueue } from "./admission.js";
import { SMOLVM_GUEST_COMMAND } from "./guest-command.js";
import { hostControlPaths } from "./host-control-paths.js";
import { SmolvmCli, createStateEnvironment } from "./cli.js";
import {
  assertMachineAlive,
  captureMachineIdentity,
  deleteStoppedMachine,
  stopMachine,
  type MachineIdentity,
} from "./lifecycle.js";
import { isWithin, validateSmolvmOptions, type CreateSmolvmExecutorOptions } from "./options.js";
import { validateSmolvmPack } from "./pack.js";
import { removeStoppedPrivateState } from "./private-state.js";
import { resolveSmolvmLimits, smolvmEnvironment, smolvmRequest } from "./request.js";
import { SMOLVM_VERSION, verifySmolvmRuntime } from "./runtime-release.js";

const NAME = "workspace";

/** Host project mode: one mount, disposable guest root, in-process ownership. */
export async function createSmolvmExecutor(
  input: CreateSmolvmExecutorOptions,
): Promise<SandboxExecutor> {
  validateSmolvmOptions(input);
  const options = structuredClone(input);
  await verifySmolvmRuntime(options.smolvmPath);
  await access("/dev/kvm", constants.R_OK | constants.W_OK);
  for (const file of [options.cwd, options.stateDirectory, options.imagePath])
    if ((await realpath(file)) !== file) throw new Error("smolvm_path_not_canonical");
  if (!(await lstat(options.cwd)).isDirectory()) throw new Error("smolvm_workspace_not_directory");
  const stateStat = await lstat(options.stateDirectory);
  if (
    !stateStat.isDirectory() ||
    stateStat.uid !== process.getuid?.() ||
    (stateStat.mode & 0o077) !== 0 ||
    Buffer.byteLength(options.stateDirectory) > 48
  )
    throw new Error("smolvm_state_requires_short_private_owned_directory");
  for (const control of await hostControlPaths()) {
    if (isWithin(options.cwd, control) || isWithin(control, options.cwd))
      throw new Error("smolvm_workspace_exposes_host_control_state");
  }
  await validateSmolvmPack(options.imagePath, options.imageSha256, options.resources);
  const state = await mkdtemp(path.join(options.stateDirectory, "vm-"));
  const executor = new PackedExecutor(options, state);
  try {
    await executor.start();
    return executor;
  } catch (cause) {
    try {
      await executor.close();
    } catch (cleanup) {
      throw new AggregateError([cause, cleanup], `smolvm_start_failed; retained state: ${state}`);
    }
    throw new SandboxExecutionError("sandbox_start_failed", { cause });
  }
}

class PackedExecutor implements SandboxExecutor {
  readonly backend = "smolvm" as const;
  readonly home = "/root";
  readonly commands = LINUX_TOOL_COMMANDS;
  readonly cwd: string;
  readonly #cli: SmolvmCli;
  readonly #queue = new AdmissionQueue();
  readonly #limits;
  readonly #environment;
  #identity: MachineIdentity | undefined;
  #created = false;
  #closing: Promise<void> | undefined;
  #closed = false;

  constructor(
    private readonly options: CreateSmolvmExecutorOptions,
    private readonly state: string,
  ) {
    this.cwd = options.cwd;
    this.#limits = resolveSmolvmLimits(options.limits);
    this.#environment = smolvmEnvironment(options.environment);
    this.#cli = new SmolvmCli({ smolvmPath: options.smolvmPath, stateDirectory: state });
  }
  async #command(argv: readonly [string, ...string[]]): Promise<SandboxCommandResult> {
    const result = await this.#cli.run({ argv, timeoutMs: 180000, maxOutputBytes: 4 * 1048576 });
    if (result.exitCode !== 0)
      throw new Error(`smolvm_command_failed: ${result.stderr.toString().slice(-2000)}`);
    return result;
  }
  async start(): Promise<void> {
    await writeFile(
      path.join(this.state, "owner.json"),
      JSON.stringify({
        version: 1,
        kind: "host-project",
        runtime: this.options.smolvmPath,
        runtimeVersion: SMOLVM_VERSION,
        imageSha256: this.options.imageSha256,
        machine: NAME,
        environment: createStateEnvironment(this.state),
        cleanup: ["machine", "stop", "--name", NAME],
      }) + "\n",
      { mode: 0o600 },
    );
    const version = await this.#command(["--version"]);
    if (version.stdout.toString().trim() !== `smolvm ${SMOLVM_VERSION}`)
      throw new Error("smolvm_version_mismatch");
    const r = this.options.resources;
    // Treat an interrupted create as potentially having made a record. Cleanup
    // consults the actual private registry before deleting any host state.
    this.#created = true;
    await this.#command([
      "machine",
      "create",
      "--name",
      NAME,
      "--from",
      this.options.imagePath,
      "--cpus",
      String(r.cpus),
      "--mem",
      String(r.memoryMiB),
      "--storage",
      String(r.storageGiB),
      "--overlay",
      String(r.overlayGiB),
      "-v",
      `${this.cwd}:${this.cwd}:${this.options.cwdWritable === false ? "ro" : "rw"}`,
    ]);
    await this.#command(["machine", "start", "--name", NAME]);
    this.#identity = await captureMachineIdentity(this.#cli, NAME);
    await this.probe();
  }
  async probe(signal?: AbortSignal): Promise<void> {
    const code =
      "for (const p of JSON.parse(process.argv[1])) require('node:fs').accessSync(p, 1);process.stdout.write('ready')";
    const result = await this.execute(
      { argv: ["/usr/bin/node", "-e", code, JSON.stringify(REQUIRED_SANDBOX_EXECUTABLES)] },
      signal ? { signal } : {},
    );
    if (result.exitCode !== 0 || result.stdout.toString() !== "ready")
      throw new Error("smolvm_guest_prerequisites_failed");
    const capacity = await this.execute(
      { argv: ["/bin/sh", "-c", "cat /sys/block/vda/size /sys/block/vdb/size"] },
      signal ? { signal } : {},
    );
    const sizes = capacity.stdout.toString().trim().split(/\s+/u).map(Number);
    if (
      capacity.exitCode !== 0 ||
      sizes.length !== 2 ||
      sizes[0] !== this.options.resources.storageGiB * 2097152 ||
      sizes[1] !== this.options.resources.overlayGiB * 2097152
    )
      throw new Error("smolvm_guest_disk_capacity_mismatch");
  }
  async execute(
    request: SandboxCommandRequest,
    options: SandboxExecutionOptions = {},
  ): Promise<SandboxCommandResult> {
    if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
    this.#queue.assertAvailable(options);
    const parsed = smolvmRequest(request, this.#limits, this.cwd);
    const deadline = performance.now() + parsed.timeoutMs;
    if (request.cwd !== undefined || request.environment !== undefined)
      throw new SandboxExecutionError("sandbox_invalid_request");
    const payload = Buffer.from(
      JSON.stringify({ argv: parsed.argv, cwd: this.cwd, environment: this.#environment }),
    ).toString("base64");
    if (payload.length > 98304) throw new SandboxExecutionError("sandbox_invalid_request");
    const release = await this.#queue.acquire({ ...options, deadline });
    try {
      if (this.#closed || !this.#identity) throw new SandboxExecutionError("sandbox_closed");
      await assertMachineAlive(this.#identity);
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
      const timeoutMs = Math.ceil(deadline - performance.now());
      if (timeoutMs <= 0) throw new SandboxExecutionError("sandbox_timeout");
      const result = await this.#cli.run(
        {
          argv: [
            "machine",
            "exec",
            "--interactive",
            "--name",
            NAME,
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
      if (result.signal !== null) throw new SandboxExecutionError("sandbox_process_failed");
      await assertMachineAlive(this.#identity);
      if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
      if (options.signal?.aborted) throw new SandboxExecutionError("sandbox_aborted");
      if (performance.now() >= deadline) throw new SandboxExecutionError("sandbox_timeout");
      return result;
    } catch (cause) {
      // Cancellation cannot leave a command mutating the shared project while a
      // later call starts. Retire the owned VM; no hidden replacement is started.
      const closing = this.close();
      release();
      try {
        await closing;
      } catch (cleanup) {
        throw new AggregateError(
          [cause, cleanup],
          `smolvm_cleanup_uncertain; retained state: ${this.state}`,
        );
      }
      throw cause;
    } finally {
      release();
    }
  }
  close(): Promise<void> {
    if (!this.#closing) {
      this.#closed = true;
      this.#queue.fail(new SandboxExecutionError("sandbox_closed"));
      this.#closing = this.#dispose();
    }
    return this.#closing;
  }
  async #dispose(): Promise<void> {
    try {
      await this.#cli.cancelActive();
      await this.#queue.idle();
      if (this.#created) {
        await stopMachine(this.#cli, NAME, this.#identity);
        await deleteStoppedMachine(this.#cli, NAME);
      }
      await this.#cli.dispose();
      await removeStoppedPrivateState(this.state);
    } catch (cause) {
      await this.#cli.dispose();
      throw new Error(
        `smolvm_cleanup_uncertain; retained state: ${this.state}; use owner.json for scoped CLI recovery`,
        { cause },
      );
    }
  }
}
