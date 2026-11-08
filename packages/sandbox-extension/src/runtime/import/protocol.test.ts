import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { isWorkerRequest, isWorkerResponse } from "../worker-protocol.js";
import { IMPORT_LIMITS } from "./contracts.js";
import { isImportOperation, isImportReply } from "./protocol.js";

const sessionId = randomUUID();
describe("scratch import protocol", () => {
  it("admits only exact operations and bounded canonical binary chunks", () => {
    for (const operation of ["begin", "finish", "verifyDirectory", "close"])
      expect(isImportOperation({ operation, sessionId })).toBe(true);
    expect(
      isImportOperation({
        operation: "write",
        sessionId,
        data: Buffer.from([0, 255]).toString("base64"),
      }),
    ).toBe(true);
    expect(
      isWorkerRequest({ type: "import", id: 1, request: { operation: "begin", sessionId } }),
    ).toBe(true);
    for (const data of [
      "",
      "!",
      "abcd\n",
      Buffer.alloc(IMPORT_LIMITS.chunkBytes + 1).toString("base64"),
    ])
      expect(isImportOperation({ operation: "write", sessionId, data })).toBe(false);
    expect(isImportOperation({ operation: "begin", sessionId, extra: true })).toBe(false);
    expect(isImportOperation({ operation: "begin", sessionId: "../outside" })).toBe(false);
    for (const path of [
      "",
      "/tmp/file",
      "../file",
      "repos/../file",
      "repos//file",
      "repos/./file",
      "x\0y",
    ])
      expect(isImportOperation({ operation: "reserveDirectory", sessionId, path })).toBe(false);
    expect(
      isImportOperation({ operation: "reserveDirectory", sessionId, path: "repos/widget" }),
    ).toBe(true);
  });
  it("bounds reply paths and errors to the scratch capability", () => {
    expect(isImportReply({ operation: "finish", path: "/proc/2/fd/12" })).toBe(true);
    expect(isImportReply({ operation: "finish", path: "/tmp/file" })).toBe(false);
    expect(
      isImportReply({
        operation: "reserveDirectory",
        directory: { path: "/proc/2/fd/12", displayPath: "/run/pi-sandbox/home/repos/widget" },
      }),
    ).toBe(true);
    expect(
      isImportReply({
        operation: "reserveDirectory",
        directory: { path: "/proc/2/fd/12", displayPath: "/run/pi-sandbox/home/../outside" },
      }),
    ).toBe(false);
    expect(isWorkerResponse({ type: "import-result", id: 2, reply: { operation: "close" } })).toBe(
      true,
    );
    expect(isWorkerResponse({ type: "import-failure", id: 2, code: "import_aborted" })).toBe(true);
    expect(isWorkerResponse({ type: "import-failure", id: 2, code: "error\ncontents" })).toBe(
      false,
    );
  });
});
