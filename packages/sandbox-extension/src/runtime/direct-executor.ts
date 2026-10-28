import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { CommandRegistry } from "./command-registry.js";
import { startSandboxProcess } from "./command-process.js";
import {
  resolveSandboxLimits,
  validateCommandRequest,
  type ResolvedSandboxLimits,
} from "./command-limits.js";
import {
  SandboxExecutionError,
  TOOL_COMMAND_NAMES,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxExecutionOptions,
  type SandboxExecutor,
  type SandboxResourceLimits,
  type ToolCommandName,
  type ToolCommandPaths,
  type ToolBundle,
} from "./contracts.js";
import { LINUX_TOOL_COMMANDS } from "./tool-commands.js";
import { snapshotToolBundle, toolBundlePath, validateToolBundle } from "./tool-bundle.js";
import { canonicalizeCommandPathPrepend, snapshotCommandPathPrepend } from "./command-path.js";

export interface CreateDirectExecutorOptions {
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly ambientEnvironment?: NodeJS.ProcessEnv;
  readonly limits?: SandboxResourceLimits;
  readonly platform?: NodeJS.Platform;
  readonly toolBundle?: ToolBundle;
  /** Trusted canonical searchable directories; aliases must be resolved before construction. */
  readonly commandPathPrepend?: readonly string[];
}

const DARWIN_PREFIXES = Object.freeze(["/opt/homebrew", "/usr/local"]);

function darwinCandidates(name: ToolCommandName): readonly string[] {
  if (name === "bash") return ["/bin/bash"];
  if (name === "sh") return ["/bin/sh"];
  if (name === "file") return ["/usr/bin/file"];
  if (name === "find")
    return DARWIN_PREFIXES.map((prefix) => `${prefix}/opt/findutils/libexec/gnubin/find`);
  if (name === "grep")
    return DARWIN_PREFIXES.map((prefix) => `${prefix}/opt/grep/libexec/gnubin/grep`);
  if (name === "awk") return DARWIN_PREFIXES.map((prefix) => `${prefix}/bin/gawk`);
  return DARWIN_PREFIXES.map((prefix) => `${prefix}/opt/coreutils/libexec/gnubin/${name}`);
}

async function isExecutable(candidate: string): Promise<boolean> {
  return access(candidate, fsConstants.X_OK).then(
    () => true,
    () => false,
  );
}

export async function resolveDirectToolCommands(
  platform: NodeJS.Platform = process.platform,
  toolBundle?: ToolBundle,
): Promise<ToolCommandPaths> {
  let selected: ToolBundle | undefined;
  if (platform !== "darwin" && platform !== "linux") {
    throw new SandboxExecutionError("sandbox_start_failed", {
      cause: new Error(`direct_execution_platform_unsupported: ${platform}`),
    });
  }

  try {
    selected = snapshotToolBundle(toolBundle);
    await validateToolBundle(selected);
  } catch (cause) {
    throw new SandboxExecutionError("sandbox_start_failed", { cause });
  }
  if (platform === "linux")
    return selected === undefined
      ? LINUX_TOOL_COMMANDS
      : Object.freeze({ ...LINUX_TOOL_COMMANDS, ...selected.commands });

  const resolved = {} as Record<ToolCommandName, string>;
  const missing: string[] = [];
  for (const name of TOOL_COMMAND_NAMES) {
    if (selected?.commands[name] !== undefined) {
      resolved[name] = selected.commands[name];
      continue;
    }
    const candidate = await firstExecutable(darwinCandidates(name));
    if (candidate === undefined) missing.push(name);
    else resolved[name] = candidate;
  }
  if (missing.length > 0) {
    throw new SandboxExecutionError("sandbox_start_failed", {
      cause: new Error(
        `Missing macOS direct-execution prerequisites: ${missing.join(", ")}. Install Homebrew bash, coreutils, findutils, grep, and gawk.`,
      ),
    });
  }
  return Object.freeze(resolved);
}

async function firstExecutable(candidates: readonly string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await isExecutable(candidate)) return candidate;
  }
  return undefined;
}

export async function createDirectExecutor(
  options: CreateDirectExecutorOptions,
): Promise<SandboxExecutor> {
  let toolBundle: ToolBundle | undefined;
  let commandPathPrepend: readonly string[];
  try {
    toolBundle = snapshotToolBundle(options.toolBundle);
    commandPathPrepend = snapshotCommandPathPrepend(options.commandPathPrepend);
  } catch (cause) {
    throw new SandboxExecutionError("sandbox_start_failed", { cause });
  }
  const cwd = path.normalize(options.cwd);
  if (!path.isAbsolute(options.cwd) || cwd !== options.cwd || options.cwd.includes("\0")) {
    throw new SandboxExecutionError("sandbox_start_failed", {
      cause: new Error("direct_execution_cwd_invalid"),
    });
  }
  const canonicalCwd = await realpath(cwd).catch((cause: unknown) => {
    throw new SandboxExecutionError("sandbox_start_failed", { cause });
  });
  const cwdStat = await stat(cwd).catch((cause: unknown) => {
    throw new SandboxExecutionError("sandbox_start_failed", { cause });
  });
  if (canonicalCwd !== cwd || !cwdStat.isDirectory()) {
    throw new SandboxExecutionError("sandbox_start_failed", {
      cause: new Error("direct_execution_cwd_not_canonical_directory"),
    });
  }

  try {
    commandPathPrepend = await canonicalizeCommandPathPrepend(
      commandPathPrepend,
      { backend: "direct", cwd },
      true,
    );
  } catch (cause) {
    throw new SandboxExecutionError("sandbox_start_failed", { cause });
  }
  const commands = await resolveDirectToolCommands(options.platform, toolBundle);
  const environment = directCommandEnvironment(
    options.ambientEnvironment ?? process.env,
    options.environment,
    toolBundle,
    commandPathPrepend,
  );
  const home = path.normalize(environment.HOME ?? homedir());
  if (!path.isAbsolute(home) || home.includes("\0")) {
    throw new SandboxExecutionError("sandbox_start_failed", {
      cause: new Error("direct_execution_home_invalid"),
    });
  }
  let limits: ResolvedSandboxLimits;
  try {
    limits = resolveSandboxLimits(options.limits);
  } catch (cause) {
    throw new SandboxExecutionError("sandbox_start_failed", { cause });
  }
  // Direct tools share command scheduling with confined tools. Host Git keeps
  // its independent HostCommandExecutor and established timing contract.
  return new DirectExecutor(cwd, home, commands, environment, limits);
}

/** Exact environment of every direct command: ambient, administrator values and tool-bundle PATH, without internal variables. */
export function directCommandEnvironment(
  ambientEnvironment: NodeJS.ProcessEnv,
  environment?: Readonly<Record<string, string>>,
  toolBundle?: ToolBundle,
  commandPathPrepend: readonly string[] = [],
): Readonly<Record<string, string>> {
  const prefixes = snapshotCommandPathPrepend(commandPathPrepend);
  const combined = { ...ambientEnvironment, ...environment };
  if (toolBundle !== undefined || prefixes.length > 0)
    combined.PATH = toolBundlePath(toolBundle, combined.PATH || "/usr/bin:/bin", prefixes);
  return Object.freeze(
    Object.fromEntries(
      Object.entries(combined).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !entry[0].startsWith("PI_SANDBOX_"),
      ),
    ),
  );
}

class DirectExecutor implements SandboxExecutor {
  readonly #commands = new CommandRegistry();
  public constructor(
    public readonly cwd: string,
    public readonly home: string,
    public readonly commands: ToolCommandPaths,
    private readonly environment: NodeJS.ProcessEnv,
    private readonly limits: ResolvedSandboxLimits,
  ) {}

  public async probe(signal?: AbortSignal): Promise<void> {
    for (const executable of Object.values(this.commands)) {
      if (!(await isExecutable(executable))) {
        throw new SandboxExecutionError("sandbox_start_failed", {
          cause: new Error(`Required direct-execution executable is unavailable: ${executable}`),
        });
      }
    }
    const result = await this.execute(
      {
        argv: [this.commands.sh, "-c", "exit 0"],
        timeoutMs: Math.min(10_000, this.limits.maximumTimeoutMs ?? 10_000),
        maxOutputBytes: 4096,
      },
      signal === undefined ? {} : { signal },
    );
    if (result.exitCode !== 0) throw new SandboxExecutionError("sandbox_start_failed");
  }

  public execute(
    request: SandboxCommandRequest,
    options: SandboxExecutionOptions = {},
  ): Promise<SandboxCommandResult> {
    const snapshot = { ...options };
    return this.#commands
      .run(snapshot.signal, async (signal) => {
        if (request.cwd !== undefined || request.environment !== undefined)
          throw new SandboxExecutionError("sandbox_invalid_request");
        const validated = validateCommandRequest(request, this.limits);
        if (signal.aborted) throw signal.reason;
        const child = startSandboxProcess({
          executable: validated.argv[0],
          argv: validated.argv.slice(1),
          cwd: this.cwd,
          environment: this.environment,
          stdin: validated.stdin,
          timeoutMs: validated.timeoutMs,
          maxOutputBytes: validated.maxOutputBytes,
          ...(snapshot.onStdout === undefined ? {} : { onStdout: snapshot.onStdout }),
          ...(snapshot.onStderr === undefined ? {} : { onStderr: snapshot.onStderr }),
        });
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

  public close(): Promise<void> {
    return this.#commands.close();
  }
}
