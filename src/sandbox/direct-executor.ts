import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import {
  createHostCommandExecutor,
  HostCommandExecutionError,
  type HostCommandExecutor,
} from "../host/index.js";
import {
  SandboxExecutionError,
  TOOL_COMMAND_NAMES,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxExecutionErrorCode,
  type SandboxExecutionOptions,
  type SandboxExecutor,
  type SandboxResourceLimits,
  type ToolCommandName,
  type ToolCommandPaths,
} from "./contracts.js";
import { LINUX_TOOL_COMMANDS } from "./bubblewrap-executor.js";

export interface CreateDirectExecutorOptions {
  readonly cwd: string;
  readonly environment?: Readonly<Record<string, string>>;
  readonly ambientEnvironment?: NodeJS.ProcessEnv;
  readonly limits?: SandboxResourceLimits;
  readonly platform?: NodeJS.Platform;
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
): Promise<ToolCommandPaths> {
  if (platform === "linux") return LINUX_TOOL_COMMANDS;
  if (platform !== "darwin") {
    throw new SandboxExecutionError("sandbox_start_failed", {
      cause: new Error(`direct_execution_platform_unsupported: ${platform}`),
    });
  }

  const resolved = {} as Record<ToolCommandName, string>;
  const missing: string[] = [];
  for (const name of TOOL_COMMAND_NAMES) {
    const selected = await firstExecutable(darwinCandidates(name));
    if (selected === undefined) missing.push(name);
    else resolved[name] = selected;
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

  const commands = await resolveDirectToolCommands(options.platform);
  const environment = {
    ...(options.ambientEnvironment ?? process.env),
    ...options.environment,
  };
  const home = path.normalize(environment.HOME ?? homedir());
  if (!path.isAbsolute(home) || home.includes("\0")) {
    throw new SandboxExecutionError("sandbox_start_failed", {
      cause: new Error("direct_execution_home_invalid"),
    });
  }
  const host = createHostCommandExecutor({
    cwd,
    environment,
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
  return new DirectExecutor(cwd, home, commands, host);
}

class DirectExecutor implements SandboxExecutor {
  public readonly backend = "direct" as const;

  public constructor(
    public readonly cwd: string,
    public readonly home: string,
    public readonly commands: ToolCommandPaths,
    private readonly host: HostCommandExecutor,
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
      { argv: [this.commands.sh, "-c", "exit 0"], maxOutputBytes: 4096 },
      signal === undefined ? {} : { signal },
    );
    if (result.exitCode !== 0) throw new SandboxExecutionError("sandbox_start_failed");
  }

  public execute(
    request: SandboxCommandRequest,
    options?: SandboxExecutionOptions,
  ): Promise<SandboxCommandResult> {
    return this.host.execute(request, options).catch((error: unknown) => {
      throw translateHostError(error);
    });
  }

  public close(): Promise<void> {
    return this.host.close();
  }
}

function translateHostError(error: unknown): SandboxExecutionError {
  if (!(error instanceof HostCommandExecutionError)) {
    return new SandboxExecutionError("sandbox_process_failed", { cause: error });
  }
  const suffix = error.code.slice("host_command_".length);
  const code = `sandbox_${suffix}` as SandboxExecutionErrorCode;
  return new SandboxExecutionError(code, { cause: error });
}
