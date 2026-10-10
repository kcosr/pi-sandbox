import path from "node:path";
import {
  DEFAULT_SANDBOX_OUTPUT_LIMIT_BYTES,
  DEFAULT_SANDBOX_TIMEOUT_MS,
  SandboxExecutionError,
  type SandboxCommandRequest,
  type SandboxResourceLimits,
} from "../contracts.js";

export type SmolvmLimits = Required<SandboxResourceLimits>;
const fail = () => new SandboxExecutionError("sandbox_invalid_request");

export function assertGuestPath(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !path.posix.isAbsolute(value) ||
    path.posix.normalize(value) !== value ||
    /[\0\r\n:]/u.test(value)
  )
    throw fail();
}

export function resolveSmolvmLimits(input: SandboxResourceLimits = {}): SmolvmLimits {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail();
  const limits = {
    defaultTimeoutMs: input.defaultTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
    maximumTimeoutMs: input.maximumTimeoutMs ?? 600_000,
    defaultOutputBytes: input.defaultOutputBytes ?? DEFAULT_SANDBOX_OUTPUT_LIMIT_BYTES,
    maximumOutputBytes: input.maximumOutputBytes ?? 64 * 1_048_576,
    maximumInputBytes: input.maximumInputBytes ?? 64 * 1_048_576,
    maximumArgumentBytes: input.maximumArgumentBytes ?? 1_048_576,
  };
  if (
    Object.keys(input).some((key) => !(key in limits)) ||
    Object.values(limits).some((n) => !Number.isSafeInteger(n) || n <= 0) ||
    limits.defaultTimeoutMs > limits.maximumTimeoutMs ||
    limits.defaultOutputBytes > limits.maximumOutputBytes ||
    limits.maximumTimeoutMs > 2_147_483_647
  )
    throw fail();
  return Object.freeze(limits);
}

/** A guest command never inherits host credentials, shell hooks or agent state. */
export function smolvmEnvironment(
  input: Readonly<Record<string, string>> = {},
): Readonly<Record<string, string>> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw fail();
  const result = { ...input };
  let bytes = 0;
  for (const [name, value] of Object.entries(result)) {
    if (
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name) ||
      typeof value !== "string" ||
      value.includes("\0") ||
      /^(?:HOME|PATH|TMPDIR|TMP|TEMP|PWD|OLDPWD|XDG_.*|LD_.*|DYLD_.*|NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|BUN_INSPECT.*|ENV|BASH_ENV|SHELLOPTS|BASHOPTS|CDPATH|GLOBIGNORE|IFS|SSH_AUTH_SOCK|SSH_AGENT_PID|.*_PROXY|.*_proxy|PI_.*|AGENT_SANDBOX_.*|SMOLVM_.*)$/u.test(
        name,
      )
    )
      throw fail();
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value) + 2;
  }
  if (bytes > 1_048_576) throw fail();
  return Object.freeze(result);
}

export interface SmolvmRequest {
  readonly argv: readonly [string, ...string[]];
  readonly cwd: string;
  readonly environment: Readonly<Record<string, string>>;
  readonly stdin: Buffer;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export function smolvmRequest(
  request: SandboxCommandRequest,
  limits: SmolvmLimits,
  defaultCwd: string,
): SmolvmRequest {
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).some(
      (key) =>
        !["argv", "cwd", "environment", "stdin", "timeoutMs", "maxOutputBytes"].includes(key),
    ) ||
    !Array.isArray(request.argv) ||
    !request.argv.length
  )
    throw fail();
  let bytes = 0;
  for (const arg of request.argv) {
    if (typeof arg !== "string" || arg.includes("\0")) throw fail();
    bytes += Buffer.byteLength(arg) + 1;
  }
  if (!path.posix.isAbsolute(request.argv[0])) throw fail();
  const cwd = request.cwd ?? defaultCwd;
  assertGuestPath(cwd);
  const environment = smolvmEnvironment(request.environment);
  for (const [key, value] of Object.entries(environment))
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value) + 2;
  if (bytes > limits.maximumArgumentBytes) throw fail();
  if (
    request.stdin !== undefined &&
    typeof request.stdin !== "string" &&
    !(request.stdin instanceof Uint8Array)
  )
    throw fail();
  const stdin = Buffer.from(request.stdin ?? "");
  if (stdin.length > limits.maximumInputBytes)
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
    throw fail();
  return {
    argv: Object.freeze([...request.argv]) as unknown as SmolvmRequest["argv"],
    cwd,
    environment,
    stdin,
    timeoutMs,
    maxOutputBytes,
  };
}
