import { boundedText } from "./bounds.js";
import type { SubagentSnapshot } from "./contracts.js";

/** The entire model-visible text, including metadata and continuation instructions. */
export const MAXIMUM_RESULT_RESPONSE_BYTES = 16 * 1024;
export const MAXIMUM_RESULT_CURSOR_LENGTH = 160;

function cursorFor(taskId: string, offset: number): string {
  return `v1:${taskId}:${offset}`;
}

export function resultOffset(cursor: string | undefined, taskId: string): number {
  if (cursor === undefined) return 0;
  if (typeof cursor !== "string" || cursor.length > MAXIMUM_RESULT_CURSOR_LENGTH)
    throw new Error("Invalid subagent result cursor");
  const match = /^v1:([a-zA-Z0-9_-]{1,128}):(0|[1-9][0-9]{0,7})$/u.exec(cursor);
  if (!match) throw new Error("Invalid subagent result cursor");
  if (match[1] !== taskId)
    throw new Error(
      "Stale subagent result cursor: the task changed; inspect the current result without a cursor",
    );
  return Number(match[2]);
}

/** Fit raw report bytes to the rendered budget, including JSON escaping when applicable. */
function fitReport(text: string, render: (prefix: string) => string): string {
  const candidate = boundedText(text, MAXIMUM_RESULT_RESPONSE_BYTES);
  const complete = render(candidate);
  if (Buffer.byteLength(complete) <= MAXIMUM_RESULT_RESPONSE_BYTES) return complete;
  let low = 0;
  let high = Buffer.byteLength(candidate);
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(render(boundedText(candidate, mid))) <= MAXIMUM_RESULT_RESPONSE_BYTES)
      low = mid;
    else high = mid - 1;
  }
  const result = render(boundedText(candidate, low));
  if (Buffer.byteLength(result) > MAXIMUM_RESULT_RESPONSE_BYTES)
    throw new Error("Subagent result metadata exceeds its response limit");
  return result;
}

export function renderResultDelivery(value: SubagentSnapshot): string {
  const header =
    value.cancelRequestedBy === "user"
      ? `Subagent cancelled by user: ${value.id} / ${value.taskId}\nOutcome: ${value.status}\nThe user cancelled this task. Do not automatically restart or replace this task.\n`
      : `Subagent result: ${value.id} / ${value.taskId}\nOutcome: ${value.status}\n`;
  const metadata = header + (value.error ? `Error: ${value.error}\n` : "");
  if (!value.result) return metadata + "No final answer";
  return fitReport(value.result, (prefix) => {
    let notice = "";
    if (value.resultBytes === undefined)
      notice =
        "\n\nFull report unavailable: the complete report was not retained. Only a bounded preview is available.";
    else if (Buffer.byteLength(prefix) < value.resultBytes)
      notice = `\n\nReport truncated. To read the remaining text:\ninspect_agent(${JSON.stringify({
        id: value.id,
        view: "result",
        cursor: cursorFor(value.taskId, Buffer.byteLength(prefix)),
      })})`;
    return metadata + prefix + notice;
  });
}

/** The caller has validated and read a bounded range of the committed report. */
export function renderResultPage(value: SubagentSnapshot, text: string, offset: number): string {
  const totalBytes = value.resultBytes!;
  return fitReport(text, (prefix) => {
    const next = offset + Buffer.byteLength(prefix);
    return JSON.stringify({
      id: value.id,
      taskId: value.taskId,
      status: value.status,
      totalBytes,
      offset,
      text: prefix,
      ...(next < totalBytes ? { nextCursor: cursorFor(value.taskId, next) } : {}),
    });
  });
}
