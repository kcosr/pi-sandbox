import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { parseSubagentConfig, readSubagentConfig } from "./config.js";

it("requires explicit boolean opt-in for waiting through child completion", () => {
  expect(parseSubagentConfig({}).waitForChildren).toBe(false);
  expect(parseSubagentConfig({ waitForChildren: true }).waitForChildren).toBe(true);
  expect(parseSubagentConfig({ waitForChildren: false }).waitForChildren).toBe(false);
  for (const waitForChildren of ["true", "false", 0, 1, null, [], {}]) {
    expect(() => parseSubagentConfig({ waitForChildren })).toThrow();
  }
});

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

it("opts into activity forwarding only through a boolean", () => {
  expect(parseSubagentConfig({}).forwardActivity).toBe(false);
  expect(parseSubagentConfig({ forwardActivity: true }).forwardActivity).toBe(true);
  for (const forwardActivity of ["true", 0, 1, null, [], {}])
    expect(() => parseSubagentConfig({ forwardActivity })).toThrow();
});

it("requires an explicitly configured file instead of silently falling back", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-config-"));
  directories.push(directory);
  const file = join(directory, "config.json");
  vi.stubEnv("PI_SUBAGENTS_CONFIG", file);
  expect(() => readSubagentConfig(directory, false)).toThrow();
  writeFileSync(file, JSON.stringify({ waitForChildren: true, forwardActivity: true }));
  expect(readSubagentConfig(directory, false)).toMatchObject({
    waitForChildren: true,
    forwardActivity: true,
  });
  writeFileSync(file, "{broken");
  expect(() => readSubagentConfig(directory, false)).toThrow();
  vi.stubEnv("PI_SUBAGENTS_CONFIG", directory);
  expect(() => readSubagentConfig(directory, false)).toThrow();
  vi.stubEnv("PI_SUBAGENTS_CONFIG", "");
  expect(() => readSubagentConfig(directory, true)).toThrow();
});

it("keeps optional project defaults and trust behavior without an explicit file", () => {
  const directory = mkdtempSync(join(tmpdir(), "subagent-config-"));
  directories.push(directory);
  vi.stubEnv("PI_SUBAGENTS_CONFIG", undefined);
  expect(readSubagentConfig(directory, true).waitForChildren).toBe(false);
  mkdirSync(join(directory, ".pi"));
  writeFileSync(
    join(directory, ".pi", "subagents.json"),
    JSON.stringify({ waitForChildren: true }),
  );
  expect(readSubagentConfig(directory, false).waitForChildren).toBe(false);
  expect(readSubagentConfig(directory, true).waitForChildren).toBe(true);
});
