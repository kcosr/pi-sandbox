import { describe, expect, it } from "vitest";
import { SubagentProgress } from "./progress.js";
import { MAXIMUM_REPORT_BYTES, MAXIMUM_RESULT_BYTES } from "./bounds.js";

describe("bounded child progress", () => {
  it("marks aggregate truncation and never retains redacted reasoning or signatures", () => {
    const progress = new SubagentProgress();
    progress.event({
      type: "message_update",
      assistantMessageEvent: {
        type: "thinking_delta",
        contentIndex: 0,
        delta: "HIDDEN_THINKING",
        partial: {
          content: [{ type: "thinking", redacted: true, thinkingSignature: "HIDDEN_SIGNATURE" }],
        },
      },
    });
    expect(progress.thinking).toBe("");
    progress.event({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "a".repeat(3000) },
          { type: "text", text: "b".repeat(3000) },
          {
            type: "thinking",
            thinking: "HIDDEN_THINKING",
            redacted: true,
            thinkingSignature: "HIDDEN_SIGNATURE",
          },
          {
            type: "thinking",
            thinking: "visible reasoning",
            thinkingSignature: "HIDDEN_SIGNATURE",
          },
        ],
        stopReason: "stop",
      },
    });
    expect(Buffer.byteLength(progress.assistant)).toBe(4096);
    expect(progress.assistantTruncated).toBe(true);
    expect(progress.thinking).toBe("visible reasoning");
    expect(JSON.stringify(progress)).not.toContain("HIDDEN");
  });
});

function answer(progress: SubagentProgress, content: readonly unknown[]) {
  progress.event({
    type: "message_end",
    message: { role: "assistant", content, stopReason: "stop" },
  });
}

describe("complete child report capture", () => {
  it("captures text beyond the preview block and byte limits without reasoning or tool payloads", () => {
    const progress = new SubagentProgress();
    const text = 'é中😀\n"'.repeat(800);
    const blocks = Array.from({ length: 160 }, (_, index) => ({
      type: "text",
      text: `${index}:${text}`,
    }));
    answer(progress, [
      ...blocks,
      { type: "thinking", thinking: "do not retain", thinkingSignature: "opaque" },
      { type: "toolCall", arguments: { text: "do not retain either" } },
    ]);
    const expected = blocks.map((block) => block.text).join("");
    expect(progress.fullAnswer).toBe(expected);
    expect(Buffer.byteLength(expected)).toBeGreaterThan(100 * 1024);
    expect(Buffer.from(expected).subarray(0, Buffer.byteLength(progress.lastAnswer))).toEqual(
      Buffer.from(progress.lastAnswer),
    );
    expect(Buffer.byteLength(progress.lastAnswer)).toBeLessThanOrEqual(MAXIMUM_RESULT_BYTES);
    expect(Buffer.byteLength(progress.assistant)).toBeLessThanOrEqual(4096);
    expect(progress.assistantTruncated).toBe(true);
  });

  it("accepts exactly 16 MiB and explicitly discards a later oversized selected answer", () => {
    const progress = new SubagentProgress();
    const exact = "x".repeat(MAXIMUM_REPORT_BYTES);
    answer(progress, [{ type: "text", text: exact }]);
    expect(progress.fullAnswer).toBe(exact);
    expect(progress.lastAnswer).toBe("x".repeat(MAXIMUM_RESULT_BYTES));
    answer(progress, [
      { type: "text", text: exact },
      { type: "text", text: "!" },
    ]);
    expect(progress.fullAnswer).toBeUndefined();
    expect(progress.lastAnswer).toBe("x".repeat(MAXIMUM_RESULT_BYTES));
    answer(progress, [{ type: "text", text: "new complete report" }]);
    expect(progress.fullAnswer).toBe("new complete report");
    expect(progress.lastAnswer).toBe("new complete report");
  });

  it("retains the last nonempty text selection and releases the full answer independently of previews", () => {
    const progress = new SubagentProgress();
    answer(progress, [{ type: "text", text: "previous answer" }]);
    answer(progress, [
      { type: "text", text: "" },
      { type: "thinking", thinking: "visible" },
    ]);
    expect(progress.fullAnswer).toBe("previous answer");
    expect(progress.lastAnswer).toBe("previous answer");
    expect(progress.assistant).toBe("previous answer");
    progress.releaseAnswer();
    expect(progress.fullAnswer).toBeUndefined();
    expect(progress.lastAnswer).toBe("previous answer");
  });

  it("counts UTF-8 exactly when surrogate pairs straddle text blocks", () => {
    const progress = new SubagentProgress();
    const prefix = "x".repeat(MAXIMUM_REPORT_BYTES - 4);
    answer(progress, [
      { type: "text", text: prefix + "\ud83d" },
      { type: "text", text: "\ude00" },
    ]);
    expect(progress.fullAnswer).toBe(prefix + "😀");
    expect(Buffer.byteLength(progress.fullAnswer!)).toBe(MAXIMUM_REPORT_BYTES);
    const early = "x".repeat(MAXIMUM_RESULT_BYTES - 3);
    answer(progress, [
      { type: "text", text: early + "\ud83d" },
      { type: "text", text: "\ude00" + "x".repeat(MAXIMUM_REPORT_BYTES) },
    ]);
    expect(progress.fullAnswer).toBeUndefined();
    expect(progress.lastAnswer).toBe(early);
  });
});
