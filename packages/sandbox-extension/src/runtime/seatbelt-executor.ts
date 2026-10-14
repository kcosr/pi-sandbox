import { constants } from "node:fs";
import { access, lstat, mkdir, mkdtemp, realpath, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  SandboxExecutionError,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxExecutionOptions,
  type SandboxExecutor,
  type ToolCommandPaths,
} from "./contracts.js";
import { resolveDirectToolCommands } from "./direct-executor.js";
import { assertToolBundlePlacement, snapshotToolBundle, toolBundlePath } from "./tool-bundle.js";
import { CommandRegistry } from "./command-registry.js";
import {
  canonicalizeSeatbeltDirectory,
  type CanonicalSeatbeltDirectory,
} from "./seatbelt/paths.js";
import {
  buildSeatbeltProfile,
  type SeatbeltPolicy,
  type SeatbeltProfile,
} from "./seatbelt/policy.js";
import { startSeatbeltProcess } from "./seatbelt/process.js";
import {
  canReadSeatbeltPath,
  resolveSeatbeltLimits,
  seatbeltBasePolicy,
  seatbeltEnvironment,
  seatbeltRequest,
  SEATBELT_LAUNCHER,
  SEATBELT_REQUIRED_EXECUTABLES,
  validateSeatbeltOptions,
  type CreateSeatbeltExecutorOptions,
  type SeatbeltLimits,
} from "./seatbelt/options.js";

export { validateSeatbeltOptions, type CreateSeatbeltExecutorOptions } from "./seatbelt/options.js";

// The final chdir runs inside the boundary: host checks alone race mutable subdirectories.
const ENTER_CWD =
  'cd -P -- "$1" || exit 125; case "$PWD" in "$2"|"$2"/*) ;; *) exit 125;; esac; shift 2; exec "$@"';
const SCRATCH_CHILDREN = [
  "home",
  "tmp",
  "cache",
  "config",
  "state",
  "control",
  "readable",
  "forbidden",
];
interface Identity {
  readonly directory: string;
  readonly dev: bigint;
  readonly ino: bigint;
}

async function identity(directory: string): Promise<Identity> {
  if ((await realpath(directory)) !== directory) throw new Error("sandbox_path_not_canonical");
  const info = await lstat(directory, { bigint: true });
  if (!info.isDirectory()) throw new Error("sandbox_path_not_directory");
  return { directory, dev: info.dev, ino: info.ino };
}
async function revalidate(expected: Identity): Promise<void> {
  const current = await identity(expected.directory);
  if (current.dev !== expected.dev || current.ino !== expected.ino)
    throw new Error("sandbox_directory_identity_changed");
}
function profileArguments(profile: SeatbeltProfile, command: readonly string[]): string[] {
  return [
    "-p",
    profile.profile,
    ...Object.entries(profile.parameters).flatMap(([key, value]) => ["-D", `${key}=${value}`]),
    ...command,
  ];
}

/** Native command confinement with best-effort process-group cleanup, never arbitrary-descendant ownership. */
export async function createSeatbeltExecutor(
  options: CreateSeatbeltExecutorOptions,
): Promise<SandboxExecutor> {
  let runtime: Identity | undefined;
  let executor: SeatbeltExecutor | undefined;
  try {
    validateSeatbeltOptions(options);
    const basePolicy = seatbeltBasePolicy(options);
    const limits = resolveSeatbeltLimits(options.limits);
    const environment = seatbeltEnvironment(options.environment);
    const toolBundle = snapshotToolBundle(options.toolBundle);
    if (process.platform !== "darwin" || !["arm64", "x64"].includes(process.arch))
      throw new Error("sandbox_seatbelt_platform_unsupported");
    if (process.getuid?.() === 0) throw new Error("sandbox_root_unsupported");
    if ((await realpath(SEATBELT_LAUNCHER)) !== SEATBELT_LAUNCHER)
      throw new Error("sandbox_seatbelt_launcher_invalid");
    await access(SEATBELT_LAUNCHER, constants.X_OK);
    const cwd = await canonicalizeSeatbeltDirectory(basePolicy.workspace);
    if (cwd !== basePolicy.workspace) throw new Error("sandbox_cwd_not_canonical");
    const denied = await Promise.all(
      basePolicy.deniedDirectories.map(async (value) => {
        const canonical = await canonicalizeSeatbeltDirectory(value);
        if (canonical !== value) throw new Error("sandbox_denied_path_not_canonical");
        return canonical;
      }),
    );
    const commands = await resolveDirectToolCommands("darwin", toolBundle);
    const executables: string[] = [];
    for (const executable of [...SEATBELT_REQUIRED_EXECUTABLES, ...Object.values(commands)]) {
      const resolved = await realpath(executable);
      if (!(await stat(resolved)).isFile() || !canReadSeatbeltPath(basePolicy, resolved))
        throw new Error("sandbox_prerequisite_denied");
      await access(resolved, constants.X_OK);
      executables.push(resolved);
    }
    const identities = await Promise.all([cwd, ...denied].map(identity));
    // mkdtemp gives an owned 0700 parent. Ambient HOME/TMPDIR cannot relocate it.
    const root = await canonicalizeSeatbeltDirectory(await mkdtemp("/private/tmp/pi-sandbox-"));
    runtime = await identity(root);
    assertToolBundlePlacement(toolBundle, cwd, basePolicy.workspaceWritable, denied, [root]);
    const writable: CanonicalSeatbeltDirectory[] = [];
    for (const name of ["home", "tmp", "cache", "config", "state"]) {
      const directory = path.join(root, name);
      await mkdir(directory, { mode: 0o700 });
      writable.push(await canonicalizeSeatbeltDirectory(directory));
    }
    const control = path.join(root, "control");
    await mkdir(control, { mode: 0o700 });
    await writeFile(path.join(control, "secret"), randomUUID(), { mode: 0o600 });
    await writeFile(path.join(root, "readable"), "sandbox-readable", { mode: 0o600 });
    const policy: SeatbeltPolicy = {
      ...basePolicy,
      temporaryDirectories: writable,
      deniedDirectories: [...denied, await canonicalizeSeatbeltDirectory(control)],
    };
    const profile = buildSeatbeltProfile(policy);
    executor = new SeatbeltExecutor(
      policy,
      profile,
      runtime,
      identities,
      limits,
      commands,
      Object.freeze(executables),
      Object.freeze({
        ...environment,
        PATH: toolBundlePath(
          toolBundle,
          "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        ),
        LANG: "C.UTF-8",
        HOME: writable[0]!,
        TMPDIR: writable[1]!,
        TMP: writable[1]!,
        TEMP: writable[1]!,
        XDG_CACHE_HOME: writable[2]!,
        XDG_CONFIG_HOME: writable[3]!,
        XDG_STATE_HOME: writable[4]!,
      }),
    );
    await executor.probe();
    return executor;
  } catch (cause) {
    if (executor) await executor.close().catch(() => undefined);
    else if (runtime) await cleanupRuntime(runtime).catch(() => undefined);
    throw new SandboxExecutionError("sandbox_start_failed", { cause });
  }
}

class SeatbeltExecutor implements SandboxExecutor {
  readonly cwd: string;
  readonly home: string;
  readonly #commands = new CommandRegistry();
  #closed = false;
  #closing: Promise<void> | undefined;
  #fatal: SandboxExecutionError | undefined;

  constructor(
    private readonly policy: SeatbeltPolicy,
    private readonly profile: SeatbeltProfile,
    private readonly runtime: Identity,
    private readonly identities: readonly Identity[],
    private readonly limits: SeatbeltLimits,
    readonly commands: ToolCommandPaths,
    private readonly requiredExecutables: readonly string[],
    private readonly environment: Readonly<Record<string, string>>,
  ) {
    this.cwd = policy.workspace;
    this.home = environment.HOME!;
  }

  async probe(signal?: AbortSignal): Promise<void> {
    try {
      for (const executable of this.requiredExecutables) await access(executable, constants.X_OK);
      const result = await this.execute(
        {
          argv: [
            "/bin/sh",
            "-c",
            `
        for executable do test -x "$executable" || exit 69; done
        test "$(/bin/cat "$PROBE_ROOT/readable")" = sandbox-readable || exit 70
        if /bin/cat "$PROBE_ROOT/control/secret" >/dev/null 2>&1; then exit 71; fi
        if (printf forbidden > "$PROBE_ROOT/forbidden") 2>/dev/null; then exit 72; fi
        (umask 077; printf private > "$TMPDIR/probe" && printf home > "$HOME/probe") || exit 73
        test "$(/bin/cat "$TMPDIR/probe")" = private || exit 74
        if test "$PROBE_WRITABLE" = true; then
          (umask 077; set -C; printf workspace > "$PROBE_FILE") || exit 75
          test "$(/bin/cat "$PROBE_FILE")" = workspace || exit 76
          /bin/rm -- "$PROBE_FILE" || exit 77
        else
          if (printf forbidden > "$PROBE_FILE") 2>/dev/null; then exit 78; fi
        fi
        printf probe-ok`,
            "seatbelt-probe",
            ...this.requiredExecutables,
          ],
          environment: {
            PROBE_ROOT: this.runtime.directory,
            PROBE_FILE: path.join(this.cwd, `.pi-sandbox-probe-${randomUUID()}`),
            PROBE_WRITABLE: String(this.policy.workspaceWritable),
          },
          timeoutMs: Math.min(10_000, this.limits.maximumTimeoutMs ?? 10_000),
          maxOutputBytes: Math.min(16_384, this.limits.maximumOutputBytes),
        },
        signal === undefined ? {} : { signal },
      );
      if (result.exitCode !== 0 || result.stdout.toString() !== "probe-ok")
        throw new Error(`sandbox_seatbelt_probe_failed:${result.exitCode}`);
    } catch (cause) {
      const error = new SandboxExecutionError("sandbox_start_failed", { cause });
      this.#fatal ??= error;
      this.#commands.fail(error);
      throw error;
    }
  }

  async execute(
    request: SandboxCommandRequest,
    options: SandboxExecutionOptions = {},
  ): Promise<SandboxCommandResult> {
    this.available();
    const validated = seatbeltRequest(request, this.limits, this.cwd);
    const snapshot = { ...options };
    return this.#commands
      .run(snapshot.signal, async (signal) => {
        this.available();
        await Promise.all([this.runtime, ...this.identities].map(revalidate)).catch(
          (cause: unknown) => {
            this.#fatal = new SandboxExecutionError("sandbox_process_failed", { cause });
            this.#commands.fail(this.#fatal);
            throw this.#fatal;
          },
        );
        if (
          (await canonicalizeSeatbeltDirectory(validated.cwd)) !== validated.cwd ||
          !canReadSeatbeltPath(this.policy, validated.cwd)
        )
          throw new SandboxExecutionError("sandbox_invalid_request");
        this.available();
        if (signal.aborted) throw signal.reason;
        const child = startSeatbeltProcess(
          SEATBELT_LAUNCHER,
          profileArguments(this.profile, [
            "/bin/sh",
            "-c",
            ENTER_CWD,
            "seatbelt-job",
            validated.cwd,
            this.cwd,
            ...validated.argv,
          ]),
          { ...this.environment, ...validated.environment },
          validated.stdin,
          validated.timeoutMs,
          validated.maxOutputBytes,
          {
            ...(snapshot.onStdout === undefined ? {} : { onStdout: snapshot.onStdout }),
            ...(snapshot.onStderr === undefined ? {} : { onStderr: snapshot.onStderr }),
          },
        );
        const abort = () => child.abort(signal.reason as SandboxExecutionError);
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        try {
          return await child.result;
        } finally {
          signal.removeEventListener("abort", abort);
        }
      })
      .catch((cause: unknown) => {
        throw cause instanceof SandboxExecutionError
          ? cause
          : new SandboxExecutionError("sandbox_process_failed", { cause });
      });
  }

  close(): Promise<void> {
    if (!this.#closing) {
      this.#closed = true;
      this.#closing = (async () => {
        await this.#commands.close();
        await cleanupRuntime(this.runtime);
      })();
    }
    return this.#closing;
  }
  private available(): void {
    if (this.#closed) throw new SandboxExecutionError("sandbox_closed");
    if (this.#fatal) throw this.#fatal;
  }
}

/** Confine recursive cleanup: a surviving command can still mutate writable scratch subtrees. */
async function cleanupRuntime(runtime: Identity): Promise<void> {
  try {
    await revalidate(runtime);
    const profile = buildSeatbeltProfile({
      workspace: runtime.directory as CanonicalSeatbeltDirectory,
      workspaceWritable: true,
      temporaryDirectories: [],
      deniedDirectories: [],
      networkMode: "none",
    });
    const child = startSeatbeltProcess(
      SEATBELT_LAUNCHER,
      profileArguments(profile, [
        "/bin/rm",
        "-rf",
        "--",
        ...SCRATCH_CHILDREN.map((name) => path.join(runtime.directory, name)),
      ]),
      { PATH: "/usr/bin:/bin", LANG: "C" },
      Buffer.alloc(0),
      5_000,
      16_384,
    );
    if ((await child.result).exitCode !== 0)
      throw new Error("sandbox_seatbelt_temp_cleanup_failed");
    await revalidate(runtime);
    await rmdir(runtime.directory);
  } catch (cause) {
    throw new SandboxExecutionError("sandbox_process_failed", { cause });
  }
}
