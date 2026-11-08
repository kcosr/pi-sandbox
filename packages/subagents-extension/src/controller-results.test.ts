import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Controller } from "./controller.js";
import { parseSubagentConfig } from "./config.js";
import { SubagentStore } from "./storage.js";
import { SubagentProgress } from "./progress.js";
import { MAXIMUM_REPORT_BYTES } from "./bounds.js";
import { renderResultDelivery } from "./results.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "subagent-reports-"));
  directories.push(root);
  const context = {
    cwd: root,
    model: { id: "fixture", provider: "fixture" },
    sessionManager: { getSessionId: () => "parent" },
  } as unknown as ExtensionContext;
  const api = { getThinkingLevel: () => "off" } as unknown as ExtensionAPI;
  const sessions: {
    emit(text: string, reason?: string): void;
    complete(text?: string, reason?: string): void;
  }[] = [];
  const host = {
    config: parseSubagentConfig({ maxTotal: 1 }, root),
    createSession: vi.fn(() => {
      let resolve!: () => void;
      let listener: ((event: unknown) => void) | undefined;
      const work = new Promise<void>((done) => {
        resolve = done;
      });
      const emit = (text: string, reason = "stop") =>
        listener?.({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text }], stopReason: reason },
        });
      sessions.push({
        emit,
        complete: (text, reason) => {
          if (text !== undefined) emit(text, reason);
          resolve();
        },
      });
      return Promise.resolve({
        subscribe: (next: (event: unknown) => void) => {
          listener = next;
          return () => {
            listener = undefined;
          };
        },
        prompt: () => work,
        abort: () => {
          resolve();
          return Promise.resolve();
        },
        dispose: () => undefined,
      } as unknown as AgentSession);
    }),
  };
  const controller = new Controller(api, host, "parent");
  return { root, context, api, host, controller, sessions };
}
type Page = {
  text: string;
  nextCursor?: string;
  offset: number;
  totalBytes: number;
  status: string;
};
function readAll(controller: Controller, id: string, cursor?: string): string {
  let output = "";
  let count = 0;
  do {
    const serialized = controller.inspect(id, "result", cursor);
    expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(16384);
    const page = JSON.parse(serialized) as Page;
    output += page.text;
    cursor = page.nextCursor;
    expect(++count).toBeLessThan(200);
  } while (cursor);
  return output;
}

describe("controller saved report lifecycle", () => {
  it("reads the exact report repeatedly and after restart, without acknowledgments or another attempt", async () => {
    const f = fixture();
    const item = await f.controller.spawn("report", false, f.context);
    expect(() => f.controller.inspect(item.id, "result")).toThrow("not ready");
    const report = '文🦉\\"\n\0'.repeat(10000);
    f.sessions[0]!.complete(report);
    await f.controller.waitForIdle();
    const first = f.controller.inspect(item.id, "result");
    const page = JSON.parse(first) as Page;
    expect(readAll(f.controller, item.id)).toBe(report);
    expect(page.text + readAll(f.controller, item.id, page.nextCursor)).toBe(report);
    expect(f.controller.inspect(item.id, "result")).toBe(first);
    expect(f.controller.snapshot()[0]!.callback).toBe("armed");
    expect(f.controller.statistics().total).toBe(1);
    expect(f.host.createSession).toHaveBeenCalledOnce();
    await f.controller.shutdown();
    const reopened = new Controller(f.api, f.host, "parent");
    try {
      expect(reopened.inspect(item.id, "result")).toBe(first);
      expect(page.text + readAll(reopened, item.id, page.nextCursor)).toBe(report);
      expect(reopened.statistics().total).toBe(1);
      expect(reopened.snapshot()[0]!.callback).toBe("disarmed");
    } finally {
      await reopened.shutdown();
    }
  });

  it.each([false, true])(
    "fences an old cursor and removes prior reports on resume (unlink failure=%s)",
    async (unlinkFails) => {
      const f = fixture();
      const item = await f.controller.spawn("first", false, f.context);
      f.sessions[0]!.complete("x".repeat(30000));
      await f.controller.waitForIdle();
      const prior = join(dirname(item.sessionFile), `report-${item.taskId}.txt`);
      const page = JSON.parse(f.controller.inspect(item.id, "result")) as Page;
      if (unlinkFails)
        vi.spyOn(SubagentStore.prototype, "removeResult").mockImplementation(() => {
          throw new Error("unlink failed");
        });
      await f.controller.resume(item.id, "next", undefined, f.context);
      expect(existsSync(prior)).toBe(unlinkFails);
      expect(() => f.controller.inspect(item.id, "result", page.nextCursor)).toThrow("Stale");
      expect(() => f.controller.inspect(item.id, "result")).toThrow("not ready");
      f.sessions[1]!.complete("second report");
      await f.controller.waitForIdle();
      expect(readAll(f.controller, item.id)).toBe("second report");
      expect(f.controller.statistics().total).toBe(1);
      await f.controller.shutdown();
    },
  );

  it("rejects result reads through a closed controller even if a resumed task leaves an old artifact", async () => {
    const f = fixture();
    const item = await f.controller.spawn("first", false, f.context);
    f.sessions[0]!.complete("old report");
    await f.controller.waitForIdle();
    await f.controller.shutdown();
    const reopened = new Controller(f.api, f.host, "parent");
    try {
      vi.spyOn(SubagentStore.prototype, "removeResult").mockImplementation(() => {
        throw new Error("unlink failed");
      });
      await reopened.resume(item.id, "next", undefined, f.context);
      expect(existsSync(join(dirname(item.sessionFile), `report-${item.taskId}.txt`))).toBe(true);
      expect(() => f.controller.inspect(item.id, "result")).toThrow("closed");
      expect(JSON.parse(f.controller.inspect(item.id))).toHaveProperty("status", "completed");
      f.sessions[1]!.complete("new report");
      await reopened.waitForIdle();
      expect(readAll(reopened, item.id)).toBe("new report");
    } finally {
      await reopened.shutdown();
    }
  });

  it("keeps a true execution outcome but announces report-file persistence failure", async () => {
    const f = fixture();
    vi.spyOn(SubagentStore.prototype, "writeResult").mockImplementation(() => {
      throw new Error("disk full");
    });
    const released = vi.spyOn(SubagentProgress.prototype, "releaseAnswer");
    const item = await f.controller.spawn("report", false, f.context);
    f.sessions[0]!.complete("completed work");
    await f.controller.waitForIdle();
    const snapshot = f.controller.snapshot()[0]!;
    expect(snapshot.status).toBe("completed");
    expect(snapshot.resultBytes).toBeUndefined();
    expect(renderResultDelivery(snapshot)).toContain("Full report unavailable");
    expect(() => f.controller.inspect(item.id, "result")).toThrow("unavailable");
    expect(() => f.controller.assertHealthy()).not.toThrow();
    expect(released).toHaveBeenCalledOnce();
    await f.controller.shutdown();
  });

  it("does not expose an artifact when terminal manifest persistence fails", async () => {
    const f = fixture();
    const item = await f.controller.spawn("report", false, f.context);
    const write = vi.spyOn(SubagentStore.prototype, "write").mockImplementation(() => {
      throw new Error("manifest failed");
    });
    f.sessions[0]!.complete("report exists only on disk");
    await vi.waitFor(() => expect(f.controller.statistics().active).toBe(0));
    expect(() => f.controller.assertHealthy()).toThrow("persistence");
    expect(f.controller.snapshot()[0]!.callback).toBe("disarmed");
    expect(f.controller.snapshot()[0]!.resultBytes).toBeUndefined();
    expect(() => f.controller.inspect(item.id, "result")).toThrow("persistence");
    write.mockRestore();
    await f.controller.shutdown();
  });

  it.each(["failed", "cancelled"] as const)(
    "retains a selected report for a %s child",
    async (outcome) => {
      const f = fixture();
      const item = await f.controller.spawn("report", false, f.context);
      f.sessions[0]!.emit("partial report", outcome === "failed" ? "error" : "stop");
      if (outcome === "cancelled") await f.controller.cancelByUser(item.id, item.taskId);
      else f.sessions[0]!.complete();
      await f.controller.waitForIdle();
      expect(f.controller.snapshot()[0]!.status).toBe(outcome);
      expect(readAll(f.controller, item.id)).toBe("partial report");
      await f.controller.shutdown();
    },
  );

  it.each(["absent-metadata", "interrupted-orphan", "missing-file", "changed-file"])(
    "fails explicitly without reconstruction or reruns: %s",
    async (kind) => {
      const f = fixture();
      const item = await f.controller.spawn("report", false, f.context);
      f.sessions[0]!.complete("saved answer");
      await f.controller.waitForIdle();
      await f.controller.shutdown();
      const path = join(f.root, "parent", "state.json");
      const state = JSON.parse(readFileSync(path, "utf8")) as {
        records: { resultBytes?: number; status: string }[];
      };
      const record = state.records[0]!;
      const artifact = join(dirname(item.sessionFile), `report-${item.taskId}.txt`);
      if (kind === "absent-metadata" || kind === "interrupted-orphan") delete record.resultBytes;
      if (kind === "interrupted-orphan") record.status = "starting";
      if (kind === "missing-file") rmSync(artifact);
      if (kind === "changed-file") writeFileSync(artifact, "wrong size");
      writeFileSync(path, JSON.stringify(state));
      const reopened = new Controller(f.api, f.host, "parent");
      try {
        expect(() => reopened.inspect(item.id, "result")).toThrow(/unavailable/iu);
        expect(reopened.statistics().total).toBe(1);
        expect(f.host.createSession).toHaveBeenCalledOnce();
      } finally {
        await reopened.shutdown();
      }
    },
  );

  it.each([MAXIMUM_REPORT_BYTES, MAXIMUM_REPORT_BYTES + 1])(
    "truthfully handles report size %i",
    async (size) => {
      const f = fixture();
      const item = await f.controller.spawn("large report", false, f.context);
      f.sessions[0]!.complete("x".repeat(size));
      await f.controller.waitForIdle();
      const snapshot = f.controller.snapshot()[0]!;
      const valid = size === MAXIMUM_REPORT_BYTES;
      expect(snapshot.resultBytes).toBe(valid ? size : undefined);
      expect(existsSync(join(dirname(item.sessionFile), `report-${item.taskId}.txt`))).toBe(valid);
      expect(renderResultDelivery(snapshot)).toContain(
        valid ? "Report truncated" : "Full report unavailable",
      );
      await f.controller.shutdown();
    },
  );

  it("validates view/cursor combinations and distinguishes no answer", async () => {
    const f = fixture();
    const item = await f.controller.spawn("empty", false, f.context);
    f.sessions[0]!.complete("");
    await f.controller.waitForIdle();
    expect(() => f.controller.inspect(item.id, "status", "cursor")).toThrow("requires view=result");
    expect(() => f.controller.inspect(item.id, "result")).toThrow("No final answer");
    await f.controller.shutdown();
  });
});
