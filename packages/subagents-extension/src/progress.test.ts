import { describe, expect, it } from "vitest";
import { SubagentProgress } from "./progress.js";

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
