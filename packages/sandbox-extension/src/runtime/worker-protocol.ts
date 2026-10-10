import { constants as osConstants } from "node:os";

import { PROCESS_LIFETIMES, type ProcessLifetime } from "./contracts.js";
import type { SandboxExecutionErrorCode } from "./contracts.js";

export const SANDBOX_WORKER_PROTOCOL_VERSION = 3;
export const MAXIMUM_SANDBOX_ACTIVE_COMMANDS = 4;
export const MAXIMUM_WORKER_PENDING_COMMANDS = 64;
export const INTERNAL_SANDBOX_WORKER_ARGUMENT = "--pi-sandbox-internal-worker";
export const MAXIMUM_WORKER_REQUEST_FRAME_BYTES = 96 * 1_048_576;
export const MAXIMUM_WORKER_RESPONSE_FRAME_BYTES = 1 * 1_048_576;

export interface WorkerExecuteRequest {
  readonly type: "execute";
  readonly id: number;
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly processLifetime: ProcessLifetime;
}

export interface WorkerCancelRequest {
  readonly type: "cancel";
  readonly id: number;
}

/** Accept an offered sandbox-lifetime result; completion still needs worker confirmation. */
export interface WorkerAcceptRequest {
  readonly type: "accept";
  readonly id: number;
}

/** Retire a terminal response after disabling all parent cancellation callbacks. */
export interface WorkerRetireRequest {
  readonly type: "retire";
  readonly id: number;
}

export interface WorkerShutdownRequest {
  readonly type: "shutdown";
}

export type WorkerRequest =
  | WorkerExecuteRequest
  | WorkerCancelRequest
  | WorkerAcceptRequest
  | WorkerRetireRequest
  | WorkerShutdownRequest;

export interface WorkerReadyResponse {
  readonly type: "ready";
  readonly protocolVersion: number;
}

export interface WorkerOutputResponse {
  readonly type: "stdout" | "stderr";
  readonly id: number;
  readonly data: string;
}

export interface WorkerResultResponse {
  readonly type: "result";
  readonly id: number;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
}

export interface WorkerFailureResponse {
  readonly type: "failure";
  readonly id: number;
  readonly code: SandboxExecutionErrorCode;
  readonly message?: string;
}

export interface WorkerCompletedResponse {
  readonly type: "completed";
  readonly id: number;
}

export type WorkerResponse =
  | WorkerReadyResponse
  | WorkerOutputResponse
  | WorkerResultResponse
  | WorkerFailureResponse
  | WorkerCompletedResponse;

export function encodeWorkerFrame(value: WorkerRequest | WorkerResponse): Buffer {
  const payload = Buffer.from(JSON.stringify(value), "utf8");
  const frame = Buffer.allocUnsafe(payload.byteLength + 4);
  frame.writeUInt32BE(payload.byteLength, 0);
  payload.copy(frame, 4);
  return frame;
}

export class WorkerFrameDecoder {
  readonly #header = Buffer.allocUnsafe(4);
  #headerBytes = 0;
  #payload: Buffer | undefined;
  #payloadBytes = 0;

  public constructor(private readonly maximumFrameBytes: number) {}

  public push(value: Buffer | string): unknown[] {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const frames: unknown[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      if (this.#payload === undefined) {
        const copied = chunk.copy(
          this.#header,
          this.#headerBytes,
          offset,
          offset + 4 - this.#headerBytes,
        );
        this.#headerBytes += copied;
        offset += copied;
        if (this.#headerBytes < 4) break;
        const length = this.#header.readUInt32BE(0);
        if (length === 0 || length > this.maximumFrameBytes) {
          throw new Error("sandbox_worker_frame_invalid");
        }
        // Allocate once after validating the length; copy each arriving byte
        // once even when a large frame is fragmented across many pipe reads.
        this.#payload = Buffer.allocUnsafe(length);
        this.#payloadBytes = 0;
        this.#headerBytes = 0;
      }
      const payload = this.#payload;
      const copied = chunk.copy(
        payload,
        this.#payloadBytes,
        offset,
        offset + payload.byteLength - this.#payloadBytes,
      );
      this.#payloadBytes += copied;
      offset += copied;
      if (this.#payloadBytes < payload.byteLength) break;
      this.#payload = undefined;
      this.#payloadBytes = 0;
      frames.push(JSON.parse(payload.toString("utf8")) as unknown);
    }
    return frames;
  }

  public finish(): void {
    if (this.#headerBytes !== 0 || this.#payload !== undefined)
      throw new Error("sandbox_worker_frame_truncated");
  }
}

export function isWorkerRequest(value: unknown): value is WorkerRequest {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "shutdown") return hasExactKeys(value, ["type"]);
  if (value.type === "cancel" || value.type === "accept" || value.type === "retire") {
    return hasExactKeys(value, ["type", "id"]) && isRequestId(value.id);
  }
  if (value.type !== "execute") return false;
  return (
    hasExactKeys(value, [
      "type",
      "id",
      "argv",
      "stdin",
      "timeoutMs",
      "maxOutputBytes",
      "processLifetime",
    ]) &&
    isRequestId(value.id) &&
    Array.isArray(value.argv) &&
    value.argv.length > 0 &&
    value.argv.every((argument) => typeof argument === "string" && !argument.includes("\0")) &&
    typeof value.stdin === "string" &&
    Number.isSafeInteger(value.timeoutMs) &&
    (value.timeoutMs as number) > 0 &&
    Number.isSafeInteger(value.maxOutputBytes) &&
    (value.maxOutputBytes as number) > 0 &&
    PROCESS_LIFETIMES.includes(value.processLifetime as ProcessLifetime)
  );
}

export function isWorkerResponse(value: unknown): value is WorkerResponse {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "ready") {
    return (
      hasExactKeys(value, ["type", "protocolVersion"]) &&
      Number.isSafeInteger(value.protocolVersion)
    );
  }
  if (!isRequestId(value.id)) return false;
  if (value.type === "completed") return hasExactKeys(value, ["type", "id"]);
  if (value.type === "stdout" || value.type === "stderr") {
    return hasExactKeys(value, ["type", "id", "data"]) && typeof value.data === "string";
  }
  if (value.type === "failure") {
    const keys =
      value.message === undefined ? ["type", "id", "code"] : ["type", "id", "code", "message"];
    return (
      hasExactKeys(value, keys) &&
      isSandboxExecutionErrorCode(value.code) &&
      (value.message === undefined || typeof value.message === "string")
    );
  }
  if (value.type !== "result") return false;
  return (
    hasExactKeys(value, ["type", "id", "exitCode", "signal"]) &&
    ((Number.isInteger(value.exitCode) &&
      (value.exitCode as number) >= 0 &&
      value.signal === null) ||
      (value.exitCode === null && isSignalName(value.signal)))
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isSignalName(value: unknown): value is NodeJS.Signals {
  return typeof value === "string" && Object.hasOwn(osConstants.signals, value);
}

function isSandboxExecutionErrorCode(value: unknown): value is SandboxExecutionErrorCode {
  return (
    typeof value === "string" &&
    [
      "sandbox_aborted",
      "sandbox_closed",
      "sandbox_input_too_large",
      "sandbox_invalid_request",
      "sandbox_output_limit_exceeded",
      "sandbox_process_failed",
      "sandbox_queue_full",
      "sandbox_admission_timeout",
      "sandbox_start_failed",
      "sandbox_timeout",
    ].includes(value)
  );
}
