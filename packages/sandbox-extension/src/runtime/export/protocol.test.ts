import { describe, expect, it } from "vitest";
import { EXPORT_LIMITS } from "./contracts.js";
import { isExportOperation, isExportReply, parseExportReaderConfiguration } from "./protocol.js";
import {
  encodeWorkerFrame,
  isWorkerRequest,
  isWorkerResponse,
  WorkerFrameDecoder,
} from "../worker-protocol.js";

describe("strict private-file protocol", () => {
  it("round-trips unsupported UTF-8 names and bounded digit-bearing failure codes", () => {
    const reply = {
      operation: "list" as const,
      page: {
        entries: [
          {
            rootId: "home" as const,
            path: "[invalid UTF-8: ff ]",
            name: "[invalid UTF-8: ff ]",
            kind: "unsupported" as const,
            size: 0,
            identity: { dev: "0", ino: "0", size: "0", mtimeNs: "0", ctimeNs: "0" },
            problem: "export_invalid_utf8_name",
          },
        ],
      },
    };
    expect(isExportReply(reply)).toBe(true);
    const response = { type: "export-result" as const, id: 1, reply };
    const decoded = new WorkerFrameDecoder(1_048_576).push(encodeWorkerFrame(response));
    expect(decoded).toEqual([response]);
    expect(isWorkerResponse(decoded[0])).toBe(true);
    expect(
      isWorkerResponse({ type: "export-failure", id: 2, code: "export_invalid_utf8_name" }),
    ).toBe(true);
    for (const code of ["", "bad-code", "bad\ncode", "x".repeat(81)]) {
      expect(isWorkerResponse({ type: "export-failure", id: 2, code })).toBe(false);
      expect(
        isExportReply({
          ...reply,
          page: { entries: [{ ...reply.page.entries[0], problem: code }] },
        }),
      ).toBe(false);
    }
  });

  it("rejects arbitrary paths, extra fields, and general commands", () => {
    expect(isExportOperation({ operation: "list", rootId: "home", path: "project" })).toBe(true);
    for (const path of [
      "/etc",
      "../outside",
      "project/../outside",
      "project//file",
      "project/./file",
    ])
      expect(isExportOperation({ operation: "list", rootId: "home", path })).toBe(false);
    expect(isExportOperation({ operation: "execute", argv: ["/bin/sh"] })).toBe(false);
    expect(
      isWorkerRequest({ type: "export", id: 1, request: { operation: "begin", extra: true } }),
    ).toBe(false);
    expect(() => parseExportReaderConfiguration('{"roots":[],"execute":"sh"}')).toThrow();
  });

  it("bounds decoded payload bytes and requires an advertised source root", () => {
    expect(isExportReply({ operation: "begin", roots: [] })).toBe(false);
    expect(
      isExportReply({
        operation: "read",
        data: Buffer.alloc(EXPORT_LIMITS.chunkBytes).toString("base64"),
      }),
    ).toBe(true);
    expect(
      isExportReply({
        operation: "read",
        data: Buffer.alloc(EXPORT_LIMITS.chunkBytes + 1).toString("base64"),
      }),
    ).toBe(false);
    expect(isExportReply({ operation: "read", data: "!!!!" })).toBe(false);
  });
});
