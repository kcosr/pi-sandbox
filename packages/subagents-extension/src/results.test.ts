import { describe, expect, it } from "vitest";
import type { SubagentSnapshot } from "./contracts.js";
import { boundedText } from "./bounds.js";
import {
  MAXIMUM_RESULT_RESPONSE_BYTES,
  renderResultDelivery,
  renderResultPage,
  resultOffset,
} from "./results.js";

const snapshot = (text: string, extra: Partial<SubagentSnapshot> = {}): SubagentSnapshot => ({
  id: "a-child",
  taskId: "task-1",
  parentSessionId: "parent",
  task: "review",
  extended: false,
  status: "completed",
  activity: "completed",
  tools: [],
  startedAt: 0,
  updatedAt: 1,
  assistant: "",
  thinking: "",
  assistantTruncated: false,
  thinkingTruncated: false,
  result: boundedText(text, 32768),
  resultBytes: Buffer.byteLength(text),
  callback: "armed",
  sessionFile: "/unused",
  provider: "fixture",
  model: "fixture",
  reasoning: "off",
  ...extra,
});

// Check the public notice and JSON pages without depending on the cursor encoding.
export function continuation(content: string): {
  prefix: string;
  id: string;
  view: "result";
  cursor: string;
} {
  const separator = "\n\nReport truncated. To read the remaining text:\ninspect_agent(";
  const index = content.lastIndexOf(separator);
  expect(index).toBeGreaterThan(0);
  return {
    prefix: content.slice(0, index),
    ...(JSON.parse(content.slice(index + separator.length, -1)) as {
      id: string;
      view: "result";
      cursor: string;
    }),
  };
}

describe("saved subagent report formatting", () => {
  it.each(["completed", "failed", "cancelled"] as const)(
    "reconstructs a %s report without repeating its automatically delivered prefix",
    (status) => {
      const report = '🦉文\\"\n\0'.repeat(10000);
      const value = snapshot(report, {
        status,
        error: "Failure metadata stays outside report",
        cancelRequestedBy: "user",
      });
      const delivered = renderResultDelivery(value);
      expect(Buffer.byteLength(delivered)).toBeLessThanOrEqual(MAXIMUM_RESULT_RESPONSE_BYTES);
      const notice = continuation(delivered);
      const prefix = notice.prefix.slice(notice.prefix.indexOf(report.slice(0, 8)));
      const initialOffset = resultOffset(notice.cursor, value.taskId);
      expect(initialOffset).toBe(Buffer.byteLength(prefix));
      expect(prefix).toBe(Buffer.from(report).subarray(0, initialOffset).toString("utf8"));
      const bytes = Buffer.from(report);
      let offset = initialOffset;
      let reconstructed = prefix;
      let pages = 0;
      while (offset < bytes.length) {
        const source = boundedText(
          bytes.subarray(offset).toString("utf8"),
          MAXIMUM_RESULT_RESPONSE_BYTES,
        );
        const serialized = renderResultPage(value, source, offset);
        expect(Buffer.byteLength(serialized)).toBeLessThanOrEqual(MAXIMUM_RESULT_RESPONSE_BYTES);
        const page = JSON.parse(serialized) as {
          text: string;
          offset: number;
          totalBytes: number;
          nextCursor?: string;
        };
        expect(page.offset).toBe(offset);
        expect(page.totalBytes).toBe(bytes.length);
        expect(page.text.length).toBeGreaterThan(0);
        reconstructed += page.text;
        offset += Buffer.byteLength(page.text);
        if (page.nextCursor) expect(resultOffset(page.nextCursor, value.taskId)).toBe(offset);
        else expect(offset).toBe(bytes.length);
        expect(++pages).toBeLessThan(200);
      }
      expect(reconstructed).toBe(report);
      expect(value.callback).toBe("armed");
    },
  );

  it("delivers a short complete report without a notice, and permits page-zero retrieval", () => {
    const value = snapshot("full short report");
    expect(renderResultDelivery(value)).toBe(
      "Subagent result: a-child / task-1\nOutcome: completed\nfull short report",
    );
    expect(JSON.parse(renderResultPage(value, value.result!, 0))).toEqual({
      id: value.id,
      taskId: value.taskId,
      status: value.status,
      totalBytes: 17,
      offset: 0,
      text: value.result,
    });
  });

  it("clearly identifies unavailable retention rather than advertising a false continuation", () => {
    const value = snapshot("x".repeat(32768));
    const unavailable = { ...value };
    delete unavailable.resultBytes;
    const result = renderResultDelivery(unavailable);
    expect(Buffer.byteLength(result)).toBeLessThanOrEqual(MAXIMUM_RESULT_RESPONSE_BYTES);
    expect(result).toContain("Full report unavailable");
    expect(result).not.toContain("inspect_agent(");
    expect(result).not.toContain("cursor");
  });

  it.each([
    "",
    "v2:task-1:10",
    "v1:task-1:-1",
    "v1:task-1:01",
    "v1:task-1:1.5",
    "v1:task-1:100000000",
    "v1:../file:1",
    "x".repeat(161),
  ])("rejects malformed cursors: %s", (cursor) => {
    expect(() => resultOffset(cursor, "task-1")).toThrow("Invalid subagent result cursor");
  });
  it("fences cursors from old tasks and other children", () => {
    expect(() => resultOffset("v1:old-task:12", "task-1")).toThrow("Stale");
    expect(resultOffset(undefined, "task-1")).toBe(0);
  });
});
