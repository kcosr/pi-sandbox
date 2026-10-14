import {
  DEFAULT_SANDBOX_OUTPUT_LIMIT_BYTES,
  SandboxExecutionError,
  type SandboxCommandRequest,
  type SandboxResourceLimits,
} from "./contracts.js";

export const MAXIMUM_COMMAND_TIMEOUT_MS = 2_147_483_647;

export interface ResolvedSandboxLimits {
  readonly maximumTimeoutMs: number | undefined;
  readonly defaultOutputBytes: number;
  readonly maximumOutputBytes: number;
  readonly maximumInputBytes: number;
  readonly maximumArgumentBytes: number;
}

function validTimeout(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value > 0 &&
    value <= MAXIMUM_COMMAND_TIMEOUT_MS
  );
}

/** One optional policy ceiling, with no implicit execution deadline. */
export function resolveCommandTimeout(requested?: number, maximum?: number): number | undefined {
  if (
    (requested !== undefined && !validTimeout(requested)) ||
    (maximum !== undefined && !validTimeout(maximum))
  )
    throw new SandboxExecutionError("sandbox_invalid_request", {
      cause: new Error("Command timeout must be positive and at most 2147483647 milliseconds"),
    });
  if (requested !== undefined && maximum !== undefined && requested > maximum)
    throw new SandboxExecutionError("sandbox_invalid_request", {
      cause: new Error(`Command timeout exceeds administrator maximum of ${maximum} milliseconds`),
    });
  return requested ?? maximum;
}

export function resolveSandboxLimits(input: SandboxResourceLimits = {}): ResolvedSandboxLimits {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("sandbox_limits_invalid");
  const limits = {
    maximumTimeoutMs: input.maximumTimeoutMs,
    defaultOutputBytes: input.defaultOutputBytes ?? DEFAULT_SANDBOX_OUTPUT_LIMIT_BYTES,
    maximumOutputBytes: input.maximumOutputBytes ?? 64 * 1_048_576,
    maximumInputBytes: input.maximumInputBytes ?? 64 * 1_048_576,
    maximumArgumentBytes: input.maximumArgumentBytes ?? 1_048_576,
  };
  if (
    Object.keys(input).some((key) => !Object.hasOwn(limits, key)) ||
    (limits.maximumTimeoutMs !== undefined && !validTimeout(limits.maximumTimeoutMs)) ||
    [
      limits.defaultOutputBytes,
      limits.maximumOutputBytes,
      limits.maximumInputBytes,
      limits.maximumArgumentBytes,
    ].some((n) => !Number.isSafeInteger(n) || n <= 0) ||
    limits.defaultOutputBytes > limits.maximumOutputBytes
  )
    throw new Error("sandbox_limits_invalid");
  return Object.freeze(limits);
}

/** Snapshot mutable request input before asynchronous launch preparation. */
export function validateCommandRequest(
  request: SandboxCommandRequest,
  limits: ResolvedSandboxLimits,
) {
  if (
    !request ||
    !Array.isArray(request.argv) ||
    request.argv.length === 0 ||
    request.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
    !request.argv[0]?.startsWith("/") ||
    request.argv.reduce((sum, arg) => sum + Buffer.byteLength(arg) + 1, 0) >
      limits.maximumArgumentBytes
  )
    throw new SandboxExecutionError("sandbox_invalid_request");
  if (
    request.stdin !== undefined &&
    typeof request.stdin !== "string" &&
    !(request.stdin instanceof Uint8Array)
  )
    throw new SandboxExecutionError("sandbox_invalid_request");
  const inputBytes =
    typeof request.stdin === "string"
      ? Buffer.byteLength(request.stdin)
      : (request.stdin?.byteLength ?? 0);
  if (inputBytes > limits.maximumInputBytes)
    throw new SandboxExecutionError("sandbox_input_too_large");
  const timeoutMs = resolveCommandTimeout(request.timeoutMs, limits.maximumTimeoutMs);
  const maxOutputBytes = request.maxOutputBytes ?? limits.defaultOutputBytes;
  if (
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes <= 0 ||
    maxOutputBytes > limits.maximumOutputBytes
  )
    throw new SandboxExecutionError("sandbox_invalid_request");
  return {
    argv: Object.freeze([...request.argv]) as readonly [string, ...string[]],
    stdin: Buffer.from(request.stdin ?? []),
    timeoutMs,
    maxOutputBytes,
  };
}
