import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { format, resolveConfig } from "prettier";
import { describe, expect, it } from "vitest";

import { renderKnownReadOnlyTable } from "./bash/registry.js";

const DOCUMENT = fileURLToPath(new URL("../../docs/configuration.md", import.meta.url));
const START = "<!-- known-read-only-commands:start -->";
const END = "<!-- known-read-only-commands:end -->";
const REGENERATE =
  "PI_SANDBOX_UPDATE_DOCS=1 npx vitest run src/permissions/known-read-only-docs.test.ts";

/** Prettier would pad every row to the widest summary; the generated table stays compact. */
function generatedBlock(): string {
  return `${START}\n\n<!-- prettier-ignore -->\n${renderKnownReadOnlyTable()}\n${END}`;
}

describe("known read-only command documentation", () => {
  it("publishes the registry table in docs/configuration.md", async () => {
    const document = await readFile(DOCUMENT, "utf8");
    const start = document.indexOf(START);
    const end = document.indexOf(END);
    expect(start, `${DOCUMENT} must contain ${START} before ${END}`).toBeGreaterThanOrEqual(0);
    expect(end, `${DOCUMENT} must contain ${START} before ${END}`).toBeGreaterThan(start);
    const current = document.slice(start, end + END.length);
    const expected = generatedBlock();
    if (current !== expected && process.env.PI_SANDBOX_UPDATE_DOCS === "1") {
      await writeFile(
        DOCUMENT,
        `${document.slice(0, start)}${expected}${document.slice(end + END.length)}`,
      );
      return;
    }
    expect(
      current,
      `The known read-only command table in docs/configuration.md does not match the registry. Regenerate it with: ${REGENERATE}`,
    ).toBe(expected);
  });

  it("keeps the generated block stable under Prettier", async () => {
    const block = `${generatedBlock()}\n`;
    const options = (await resolveConfig(DOCUMENT)) ?? {};
    expect(
      await format(block, { ...options, filepath: DOCUMENT }),
      "Prettier must leave the generated known read-only block unchanged",
    ).toBe(block);
  });
});
