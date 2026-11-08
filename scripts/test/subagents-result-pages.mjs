import assert from "node:assert/strict";
import { Buffer } from "node:buffer";

export function longSubagentReport(marker) {
  return `${marker}\n${Array.from(
    { length: 1400 },
    (_, index) =>
      `${index}: café 漢字 🧪 \\"quoted\\" \\path\\file\tresult evidence and conclusions.\n`,
  ).join("")}FINAL_REPORT_TAIL_${marker}`;
}

/** Exercise the public tool through the actual parent model's tool calls. */
export async function assertSubagentResultPages({ id, taskId, notice, report, inspect }) {
  assert(Buffer.byteLength(report) > 100_000, "Fixture must exceed the former capture limit");
  assert(Buffer.byteLength(notice) <= 16 * 1024, "Automatic result must fit its whole budget");
  const separator = "\n\nReport truncated. To read the remaining text:\ninspect_agent(";
  const boundary = notice.lastIndexOf(separator);
  assert(boundary > 0, "Automatic result must explicitly explain how to read its tail");
  const call = notice.slice(boundary + separator.length);
  assert(call.endsWith(")"), "Notice must contain an executable inspect_agent call");
  const args = JSON.parse(call.slice(0, -1));
  assert.deepEqual(Object.keys(args).sort(), ["cursor", "id", "view"]);
  assert.equal(args.id, id);
  assert.equal(args.view, "result");
  assert.equal(typeof args.cursor, "string");
  const reportStart = notice.indexOf(report.slice(0, report.indexOf("\n")));
  assert(reportStart >= 0);
  const prefix = notice.slice(reportStart, boundary);
  assert(prefix.length > 6000, "The automatic report budget must be larger than before");
  assert(report.startsWith(prefix), "Automatic text must be the exact report prefix");

  async function pages(firstArgs, expectedOffset) {
    let next = firstArgs;
    let offset = expectedOffset;
    let result = "";
    let first;
    for (let count = 0; next && count < 64; count++) {
      const raw = await inspect(next);
      assert(Buffer.byteLength(raw) <= 16 * 1024, "Escaped JSON page must fit its whole budget");
      const page = JSON.parse(raw);
      assert.deepEqual(
        Object.keys(page).sort(),
        [
          "id",
          "taskId",
          "status",
          "totalBytes",
          "offset",
          "text",
          ...(page.nextCursor ? ["nextCursor"] : []),
        ].sort(),
      );
      assert.equal(page.id, id);
      assert.equal(page.taskId, taskId);
      assert.equal(page.status, "completed");
      assert.equal(page.totalBytes, Buffer.byteLength(report));
      assert.equal(page.offset, offset);
      assert.equal(typeof page.text, "string");
      assert(page.text.length > 0);
      if (!first) first = raw;
      result += page.text;
      offset += Buffer.byteLength(page.text);
      next = page.nextCursor ? { id, view: "result", cursor: page.nextCursor } : undefined;
    }
    assert.equal(next, undefined, "Result pagination must terminate");
    assert.equal(offset, Buffer.byteLength(report));
    assert.equal(await inspect(firstArgs), first, "Repeated reads must return identical pages");
    return result;
  }
  assert.equal(prefix + (await pages(args, Buffer.byteLength(prefix))), report);
  assert.equal(await pages({ id, view: "result" }, 0), report);
  const status = await inspect({ id });
  assert(Buffer.byteLength(status) <= 4096, "Default inspection must remain compact");
  assert.equal(JSON.parse(status).taskId, taskId);
  assert.equal(
    JSON.parse(status).totalBytes,
    undefined,
    "Default inspection remains the status view",
  );
}
