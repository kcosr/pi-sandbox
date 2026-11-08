export const MAXIMUM_TASK_BYTES = 32 * 1024;
export const MAXIMUM_RESULT_BYTES = 32 * 1024;
export const MAXIMUM_REPORT_BYTES = 16 * 1024 * 1024;
export const MAXIMUM_PROGRESS_BYTES = 4096;
export function boundedText(text: string, maximum: number): string {
  const data = Buffer.from(text);
  if (data.length <= maximum) return text;
  let end = maximum;
  while (end > 0 && (data[end]! & 0xc0) === 0x80) end--;
  return data.subarray(0, end).toString("utf8");
}
export function boundedTail(text: string, maximum: number): string {
  const data = Buffer.from(text);
  if (data.length <= maximum) return text;
  let start = data.length - maximum;
  while (start < data.length && (data[start]! & 0xc0) === 0x80) start++;
  return data.subarray(start).toString("utf8");
}
export function validateTask(text: string): void {
  if (
    typeof text !== "string" ||
    text.trim().length === 0 ||
    Buffer.byteLength(text) > MAXIMUM_TASK_BYTES
  )
    throw new Error("Task or message must contain 1–32768 UTF-8 bytes");
}
import { closeSync, constants, fstatSync, openSync, readSync } from "node:fs";

export function readBoundedFile(path: string, maximum: number): string {
  const file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(file);
    if (!stat.isFile() || stat.size > maximum)
      throw new Error("Subagent input exceeds its file limit");
    const buffer = Buffer.alloc(Math.min(maximum + 1, stat.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(file, buffer, length, buffer.length - length, null);
      if (count === 0) return buffer.subarray(0, length).toString("utf8");
      length += count;
    }
    if (length > stat.size) throw new Error("Subagent input changed during bounded reading");
    return buffer.subarray(0, length).toString("utf8");
  } finally {
    closeSync(file);
  }
}
