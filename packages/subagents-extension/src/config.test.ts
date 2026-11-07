import { expect, it } from "vitest";
import { parseSubagentConfig } from "./config.js";

it("requires explicit boolean opt-in for waiting through child completion", () => {
  expect(parseSubagentConfig({}).waitForChildren).toBe(false);
  expect(parseSubagentConfig({ waitForChildren: true }).waitForChildren).toBe(true);
  expect(parseSubagentConfig({ waitForChildren: false }).waitForChildren).toBe(false);
  for (const waitForChildren of ["true", "false", 0, 1, null, [], {}]) {
    expect(() => parseSubagentConfig({ waitForChildren })).toThrow();
  }
});
