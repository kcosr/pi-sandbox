import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { readSandboxConfig, parseSandboxConfig } from "./config.js";

const config = {
  version: 1,
  mode: "owned",
  backend: { kind: "direct", environment: {} },
  tools: { read: { mode: "allow", sessionGrant: "never" } },
  userBash: false,
};
describe("standalone sandbox configuration", () => {
  it("keeps an explicit empty tool set and freezes policy", () => {
    expect(parseSandboxConfig({ ...config, tools: {} }).tools).toEqual({});
    const parsed = parseSandboxConfig(config);
    expect(Object.isFrozen(parsed.tools.read)).toBe(true);
  });
  it("rejects legacy/unknown keys, backend fallback and malformed policies", () => {
    for (const input of [
      { ...config, attachment: {} },
      { ...config, version: 2 },
      { ...config, backend: { kind: "automatic", environment: {} } },
      { ...config, tools: { read: { mode: "allow" } } },
      { ...config, tools: { unknown: { mode: "allow", sessionGrant: "never" } } },
      { ...config, backend: { kind: "direct", environment: { SECRET: 42 } } },
    ])
      expect(() => parseSandboxConfig(input)).toThrow();
  });
  it.skipIf(process.platform === "win32")(
    "rejects a FIFO config without waiting for a writer",
    async () => {
      const dir = await mkdtemp("/var/tmp/pi-extension-config-");
      try {
        const fifo = join(dir, "config.json");
        execFileSync("mkfifo", ["-m", "600", fifo]);
        await expect(readSandboxConfig(fifo)).rejects.toThrow("regular file");
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );
});
