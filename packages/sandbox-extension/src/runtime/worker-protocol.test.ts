import { describe, expect, it } from "vitest";

import {
  encodeWorkerFrame,
  isWorkerRequest,
  isWorkerResponse,
  WorkerFrameDecoder,
} from "./worker-protocol.js";

describe("sandbox worker protocol", () => {
  it("decodes fragmented and adjacent frames without message-boundary ambiguity", () => {
    const first = encodeWorkerFrame({
      type: "execute",
      id: 1,
      argv: ["/bin/printf", "hello"],
      stdin: "",
      timeoutMs: 1_000,
      maxOutputBytes: 1_024,
      processLifetime: "command",
    });
    const second = encodeWorkerFrame({ type: "cancel", id: 1 });
    const combined = Buffer.concat([first, second]);
    const decoder = new WorkerFrameDecoder(16_384);

    expect(decoder.push(combined.subarray(0, 3))).toEqual([]);
    expect(decoder.push(combined.subarray(3, first.byteLength + 2))).toEqual([
      {
        type: "execute",
        id: 1,
        argv: ["/bin/printf", "hello"],
        stdin: "",
        timeoutMs: 1_000,
        maxOutputBytes: 1_024,
        processLifetime: "command",
      },
    ]);
    expect(decoder.push(combined.subarray(first.byteLength + 2))).toEqual([
      { type: "cancel", id: 1 },
    ]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("rejects oversized, empty, and truncated frames", () => {
    const oversized = Buffer.alloc(4);
    oversized.writeUInt32BE(17, 0);
    expect(() => new WorkerFrameDecoder(16).push(oversized)).toThrow(
      "sandbox_worker_frame_invalid",
    );

    const empty = Buffer.alloc(4);
    expect(() => new WorkerFrameDecoder(16).push(empty)).toThrow("sandbox_worker_frame_invalid");

    const decoder = new WorkerFrameDecoder(16);
    expect(decoder.push(Buffer.from([0, 0, 0, 2, 0x7b]))).toEqual([]);
    expect(() => decoder.finish()).toThrow("sandbox_worker_frame_truncated");
  });

  it("assembles a large fragmented frame and preserves adjacent frame boundaries", () => {
    const response = { type: "stdout", id: 1, data: "x".repeat(1_048_576) } as const;
    const frame = Buffer.concat([
      encodeWorkerFrame(response),
      encodeWorkerFrame({ type: "completed", id: 1 }),
    ]);
    const decoder = new WorkerFrameDecoder(2 * 1_048_576);
    const decoded: unknown[] = [];
    for (let offset = 0; offset < frame.byteLength; offset += 127) {
      decoded.push(...decoder.push(frame.subarray(offset, offset + 127)));
    }
    expect(decoded).toEqual([response, { type: "completed", id: 1 }]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("owns partial header and payload bytes independently of the input buffer", () => {
    const frame = encodeWorkerFrame({ type: "cancel", id: 42 });
    const decoder = new WorkerFrameDecoder(1_024);
    const header = Buffer.from(frame.subarray(0, 2));
    expect(decoder.push(header)).toEqual([]);
    header.fill(0xff);
    const payload = Buffer.from(frame.subarray(2, 10));
    expect(decoder.push(payload)).toEqual([]);
    payload.fill(0xff);
    expect(decoder.push(frame.subarray(10))).toEqual([{ type: "cancel", id: 42 }]);
    expect(() => decoder.finish()).not.toThrow();
  });

  it("validates the request and response message shapes", () => {
    expect(
      isWorkerRequest({
        type: "execute",
        id: 2,
        argv: ["/bin/true"],
        stdin: "",
        timeoutMs: 1,
        maxOutputBytes: 1,
        processLifetime: "sandbox",
      }),
    ).toBe(true);
    expect(isWorkerRequest({ type: "execute", id: 0, argv: [] })).toBe(false);
    expect(isWorkerRequest({ type: "cancel", id: 2, extra: true })).toBe(false);
    expect(isWorkerRequest({ type: "accept", id: 2 })).toBe(true);
    expect(isWorkerRequest({ type: "accept", id: 0 })).toBe(false);
    expect(isWorkerRequest({ type: "accept", id: 2, extra: true })).toBe(false);
    expect(isWorkerRequest({ type: "retire", id: 2 })).toBe(true);
    expect(isWorkerRequest({ type: "retire", id: 0 })).toBe(false);
    expect(isWorkerRequest({ type: "retire", id: 2, extra: true })).toBe(false);
    expect(isWorkerResponse({ type: "ready", protocolVersion: 3 })).toBe(true);
    expect(isWorkerResponse({ type: "completed", id: 2 })).toBe(true);
    expect(isWorkerResponse({ type: "completed", id: 0 })).toBe(false);
    expect(isWorkerResponse({ type: "completed", id: 2, exitCode: 0 })).toBe(false);
    expect(isWorkerResponse({ type: "result", id: 2, exitCode: 0, signal: "SIGTERM" })).toBe(false);
    expect(isWorkerResponse({ type: "failure", id: 2, code: "not_a_code" })).toBe(false);
    expect(isWorkerResponse({ type: "failure", id: 2, code: "sandbox_queue_full" })).toBe(true);
  });

  it.each([undefined, null, "session", true])(
    "rejects invalid process lifetime %s",
    (processLifetime) => {
      expect(
        isWorkerRequest({
          type: "execute",
          id: 2,
          argv: ["/bin/true"],
          stdin: "",
          timeoutMs: 1,
          maxOutputBytes: 1,
          processLifetime,
        }),
      ).toBe(false);
    },
  );
});
