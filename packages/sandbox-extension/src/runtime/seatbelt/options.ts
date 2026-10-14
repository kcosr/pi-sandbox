import {
  DEFAULT_SANDBOX_OUTPUT_LIMIT_BYTES,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  SandboxExecutionError,
  type SandboxCommandRequest,
  type SandboxResourceLimits,
  type ToolBundle,
} from "../contracts.js";
import { assertToolBundlePlacement, snapshotToolBundle } from "../tool-bundle.js";
import {
  assertSeatbeltPath,
  isSeatbeltPathWithin,
  type CanonicalSeatbeltDirectory,
} from "./paths.js";
import { buildSeatbeltProfile, type SeatbeltPolicy } from "./policy.js";

export interface CreateSeatbeltExecutorOptions {
  readonly cwd: string;
  readonly cwdWritable?: boolean;
  /** Existing canonical directories denied access, not masked by private mounts. */
  readonly deniedPaths?: readonly string[];
  readonly networkMode?: "none" | "host";
  readonly environment?: Readonly<Record<string, string>>;
  readonly limits?: SandboxResourceLimits;
  readonly toolBundle?: ToolBundle;
}

export const SEATBELT_LAUNCHER = "/usr/bin/sandbox-exec";
export const SEATBELT_REQUIRED_EXECUTABLES = ["/bin/sh", "/bin/cat", "/bin/rm"] as const;
export type SeatbeltLimits = Required<SandboxResourceLimits>;
const ARGUMENT_CEILING = 1_048_576;

export function seatbeltBasePolicy(options: CreateSeatbeltExecutorOptions): SeatbeltPolicy {
  return Object.freeze({
    workspace: options.cwd as CanonicalSeatbeltDirectory,
    workspaceWritable: options.cwdWritable ?? true,
    temporaryDirectories: Object.freeze([]),
    deniedDirectories: Object.freeze([
      ...(options.deniedPaths ?? []),
    ]) as readonly CanonicalSeatbeltDirectory[],
    networkMode: options.networkMode ?? "none",
  });
}

export function canReadSeatbeltPath(policy: SeatbeltPolicy, target: string): boolean {
  return policy.deniedDirectories.every(
    (denied) =>
      !isSeatbeltPathWithin(denied, target) ||
      (isSeatbeltPathWithin(denied, policy.workspace) &&
        isSeatbeltPathWithin(policy.workspace, target)),
  );
}

/** Pure administrative preflight. Native creation additionally checks filesystem identities and enforcement. */
export function validateSeatbeltOptions(options: CreateSeatbeltExecutorOptions): void {
  if (
    !options ||
    typeof options !== "object" ||
    Array.isArray(options) ||
    Object.keys(options).some(
      (key) =>
        ![
          "cwd",
          "cwdWritable",
          "deniedPaths",
          "networkMode",
          "environment",
          "limits",
          "toolBundle",
        ].includes(key),
    )
  )
    throw new Error("sandbox_seatbelt_options_invalid");
  if (options.cwdWritable !== undefined && typeof options.cwdWritable !== "boolean")
    throw new Error("sandbox_seatbelt_options_invalid");
  if (
    options.networkMode !== undefined &&
    options.networkMode !== "none" &&
    options.networkMode !== "host"
  )
    throw new Error("sandbox_seatbelt_options_invalid");
  // One internal denial protects the executor's control directory.
  if (
    (options.deniedPaths !== undefined && !Array.isArray(options.deniedPaths)) ||
    (options.deniedPaths?.length ?? 0) > 63
  )
    throw new Error("sandbox_denied_paths_invalid");
  const policy = seatbeltBasePolicy(options);
  buildSeatbeltProfile(policy);
  const toolBundle = snapshotToolBundle(options.toolBundle);
  assertToolBundlePlacement(toolBundle, options.cwd, policy.workspaceWritable, options.deniedPaths);
  resolveSeatbeltLimits(options.limits);
  seatbeltEnvironment(options.environment);
  for (const executable of SEATBELT_REQUIRED_EXECUTABLES)
    if (!canReadSeatbeltPath(policy, executable)) throw new Error("sandbox_prerequisite_denied");
}

export function resolveSeatbeltLimits(input: SandboxResourceLimits = {}): SeatbeltLimits {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("sandbox_limits_invalid");
  const limits = {
    defaultTimeoutMs: input.defaultTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
    maximumTimeoutMs: input.maximumTimeoutMs ?? 600_000,
    defaultOutputBytes: input.defaultOutputBytes ?? DEFAULT_SANDBOX_OUTPUT_LIMIT_BYTES,
    maximumOutputBytes: input.maximumOutputBytes ?? 64 * 1_048_576,
    maximumInputBytes: input.maximumInputBytes ?? 64 * 1_048_576,
    maximumArgumentBytes: input.maximumArgumentBytes ?? ARGUMENT_CEILING,
  };
  if (
    Object.keys(input).some((key) => !Object.hasOwn(limits, key)) ||
    Object.values(limits).some((n) => !Number.isSafeInteger(n) || n <= 0) ||
    limits.defaultTimeoutMs > limits.maximumTimeoutMs ||
    limits.defaultOutputBytes > limits.maximumOutputBytes ||
    limits.maximumTimeoutMs > 2_147_483_647
  )
    throw new Error("sandbox_limits_invalid");
  return Object.freeze(limits);
}

/** No ambient inheritance or loader, shell, proxy, agent-socket or scratch-path injection. */
export function seatbeltEnvironment(
  input: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("sandbox_environment_invalid");
  const result = { ...input };
  let bytes = 0;
  for (const [name, value] of Object.entries(result)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      typeof value !== "string" ||
      value.includes("\0") ||
      /^(?:HOME|PATH|LANG|TMPDIR|TMP|TEMP|PWD|OLDPWD|XDG_.*|LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|BUN_INSPECT.*|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|IFS|SSH_AUTH_SOCK|SSH_AGENT_PID|.*_PROXY|.*_proxy|PI_SANDBOX_.*|AGENT_SANDBOX_.*)$/u.test(
        name,
      )
    )
      throw new Error("sandbox_environment_invalid");
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 2;
  }
  if (bytes > ARGUMENT_CEILING) throw new Error("sandbox_environment_too_large");
  return Object.freeze(result);
}

export interface SeatbeltRequest {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin: Buffer;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export function seatbeltRequest(
  request: SandboxCommandRequest,
  limits: SeatbeltLimits,
  root: string,
): SeatbeltRequest {
  try {
    if (!request || !Array.isArray(request.argv) || !request.argv.length)
      throw new Error("sandbox_argv_invalid");
    let bytes = 0;
    for (const arg of request.argv) {
      if (typeof arg !== "string" || arg.includes("\0")) throw new Error("sandbox_argv_invalid");
      bytes += Buffer.byteLength(arg) + 1;
    }
    if (!request.argv[0].startsWith("/")) throw new Error("sandbox_executable_not_absolute");
    const cwd = request.cwd ?? root;
    assertSeatbeltPath(cwd);
    if (!isSeatbeltPathWithin(root, cwd)) throw new Error("sandbox_cwd_outside_workspace");
    const environment = seatbeltEnvironment(request.environment);
    for (const [name, value] of Object.entries(environment))
      bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 2;
    if (bytes > limits.maximumArgumentBytes) throw new Error("sandbox_arguments_too_large");
    if (
      request.stdin !== undefined &&
      typeof request.stdin !== "string" &&
      !(request.stdin instanceof Uint8Array)
    )
      throw new Error("sandbox_stdin_invalid");
    const inputBytes =
      typeof request.stdin === "string"
        ? Buffer.byteLength(request.stdin)
        : (request.stdin?.byteLength ?? 0);
    if (inputBytes > limits.maximumInputBytes)
      throw new SandboxExecutionError("sandbox_input_too_large");
    const timeoutMs = request.timeoutMs ?? limits.defaultTimeoutMs;
    const maxOutputBytes = request.maxOutputBytes ?? limits.defaultOutputBytes;
    if (
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs <= 0 ||
      timeoutMs > limits.maximumTimeoutMs ||
      !Number.isSafeInteger(maxOutputBytes) ||
      maxOutputBytes <= 0 ||
      maxOutputBytes > limits.maximumOutputBytes
    )
      throw new Error("sandbox_request_limits_invalid");
    return {
      argv: Object.freeze([...request.argv]) as readonly [string, ...string[]],
      cwd,
      environment,
      stdin: Buffer.from(request.stdin ?? []),
      timeoutMs,
      maxOutputBytes,
    };
  } catch (cause) {
    throw cause instanceof SandboxExecutionError
      ? cause
      : new SandboxExecutionError("sandbox_invalid_request", { cause });
  }
}
