import {
  boundedTail,
  boundedText,
  MAXIMUM_PROGRESS_BYTES,
  MAXIMUM_RESULT_BYTES,
} from "./bounds.js";

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Only text is retained. Provider signatures and opaque reasoning payloads are never copied. */
export class SubagentProgress {
  public assistant = "";
  public thinking = "";
  public assistantTruncated = false;
  public thinkingTruncated = false;
  public activity = "starting";
  public lastAnswer = "";
  public stopReason: string | undefined;
  public error: string | undefined;
  private readonly active = new Map<string, string>();
  private readonly blocks = new Map<number, { type: "text" | "thinking"; value: string }>();
  public get tools(): readonly string[] {
    return [...this.active.values()];
  }

  public event(event: unknown): void {
    if (!object(event)) return;
    if (event.type === "agent_start") this.activity = "thinking";
    if (
      event.type === "message_start" &&
      object(event.message) &&
      event.message.role === "assistant"
    )
      this.blocks.clear();
    if (event.type === "message_update" && object(event.assistantMessageEvent)) {
      const update = event.assistantMessageEvent;
      if (
        typeof update.type === "string" &&
        ["text_delta", "text_end", "thinking_delta", "thinking_end"].includes(update.type) &&
        typeof update.contentIndex === "number" &&
        update.contentIndex >= 0 &&
        update.contentIndex < 128
      ) {
        const type = update.type.startsWith("text") ? "text" : "thinking";
        const part: unknown =
          object(update.partial) && Array.isArray(update.partial.content)
            ? update.partial.content[update.contentIndex]
            : undefined;
        if (type === "thinking" && object(part) && part.redacted) {
          this.blocks.delete(update.contentIndex);
          this.preview(type);
          return;
        }
        const delta = update.type.endsWith("_delta") ? update.delta : update.content;
        if (typeof delta === "string") {
          const prior = update.type.endsWith("_delta")
            ? (this.blocks.get(update.contentIndex)?.value ?? "")
            : "";
          const value = prior + boundedTail(delta, MAXIMUM_PROGRESS_BYTES);
          if (
            Buffer.byteLength(value) > MAXIMUM_PROGRESS_BYTES ||
            Buffer.byteLength(delta) > MAXIMUM_PROGRESS_BYTES
          ) {
            if (type === "text") this.assistantTruncated = true;
            else this.thinkingTruncated = true;
          }
          this.blocks.set(update.contentIndex, {
            type,
            value: boundedTail(value, MAXIMUM_PROGRESS_BYTES),
          });
          this.preview(type);
          this.activity = type === "text" ? "writing" : "thinking";
        }
      }
    }
    if (
      event.type === "message_end" &&
      object(event.message) &&
      event.message.role === "assistant"
    ) {
      const message = event.message;
      this.blocks.clear();
      let answer = "";
      if (Array.isArray(message.content))
        for (const [index, part] of message.content.entries()) {
          if (index >= 128) {
            this.assistantTruncated = true;
            this.thinkingTruncated = true;
            break;
          }
          if (!object(part)) continue;
          if (part.type === "text" && typeof part.text === "string") {
            answer = boundedText(
              answer + boundedText(part.text, MAXIMUM_RESULT_BYTES),
              MAXIMUM_RESULT_BYTES,
            );
            this.blocks.set(index, {
              type: "text",
              value: boundedTail(part.text, MAXIMUM_PROGRESS_BYTES),
            });
            if (Buffer.byteLength(part.text) > MAXIMUM_PROGRESS_BYTES)
              this.assistantTruncated = true;
          }
          if (part.type === "thinking" && !part.redacted && typeof part.thinking === "string") {
            this.blocks.set(index, {
              type: "thinking",
              value: boundedTail(part.thinking, MAXIMUM_PROGRESS_BYTES),
            });
            if (Buffer.byteLength(part.thinking) > MAXIMUM_PROGRESS_BYTES)
              this.thinkingTruncated = true;
          }
        }
      if (answer) {
        this.lastAnswer = answer;
        this.preview("text");
      }
      this.preview("thinking");
      this.stopReason = typeof message.stopReason === "string" ? message.stopReason : undefined;
      this.error =
        typeof message.errorMessage === "string"
          ? boundedText(message.errorMessage, 1024)
          : undefined;
    }
    if (
      event.type === "tool_execution_start" &&
      typeof event.toolCallId === "string" &&
      typeof event.toolName === "string" &&
      this.active.size < 128
    )
      this.active.set(event.toolCallId, boundedText(event.toolName, 256));
    if (event.type === "tool_execution_end" && typeof event.toolCallId === "string")
      this.active.delete(event.toolCallId);
    if (this.active.size) this.activity = "running tools";
    else if (event.type === "tool_execution_end") this.activity = "thinking";
  }
  private preview(type: "text" | "thinking"): void {
    let value = "";
    for (const [, block] of [...this.blocks].sort(([left], [right]) => left - right))
      if (block.type === type) {
        if (Buffer.byteLength(value + block.value) > MAXIMUM_PROGRESS_BYTES) {
          if (type === "text") this.assistantTruncated = true;
          else this.thinkingTruncated = true;
        }
        value = boundedTail(value + block.value, MAXIMUM_PROGRESS_BYTES);
      }
    if (type === "text") this.assistant = value;
    else this.thinking = value;
  }
}
