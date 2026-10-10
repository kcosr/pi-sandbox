import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { readSandboxConfig, parseSandboxConfig } from "./config.js";

const config = {
  version: 4,
  mode: "owned",
  backend: { kind: "direct", environment: {} },
  userBash: false,
};
describe("standalone sandbox configuration", () => {
  it("freezes the explicit execution configuration", () => {
    const parsed = parseSandboxConfig(config);
    expect(Object.isFrozen(parsed)).toBe(true);
    if (parsed.mode !== "owned") throw Error("Expected owned sandbox");
    expect(Object.isFrozen(parsed.backend)).toBe(true);
  });
  it("rejects old versions, permissions fields and backend fallback", () => {
    for (const input of [
      { ...config, attachment: {} },
      { ...config, version: 2 },
      { ...config, version: 3 },
      { ...config, requirePermissions: undefined },
      { ...config, requirePermissions: "true" },
      { ...config, backend: { kind: "automatic", environment: {} } },
      { ...config, tools: {} },
      { ...config, tools: { read: { mode: "allow", sessionGrant: "never" } } },
      { ...config, backend: { kind: "direct", environment: { SECRET: 42 } } },
    ])
      expect(() => parseSandboxConfig(input)).toThrow();
  });
  it("accepts explicit VM ownership or a scoped attachment, never both", () => {
    const backend = {
      kind: "smolvm",
      executable: "/opt/smolvm/smolvm",
      image: "/images/tools.smolmachine",
      imageSha256: "a".repeat(64),
      stateDirectory: "/state",
      resources: { cpus: 1, memoryMiB: 512, storageGiB: 1, overlayGiB: 1 },
      cwdWritable: true,
      environment: {},
    };
    expect(parseSandboxConfig({ ...config, backend }).mode).toBe("owned");
    const attachment = {
      version: 1,
      socketPath: "/private/control.sock",
      token: "b".repeat(64),
      machineId: "candidate",
      cwd: "/workspace",
      home: "/root",
    };
    const attached = {
      version: 4,
      mode: "attached",
      attachment,
      userBash: false,
    };
    expect(parseSandboxConfig(attached).mode).toBe("attached");
    expect(() => parseSandboxConfig({ ...attached, backend })).toThrow();
    expect(() =>
      parseSandboxConfig({ ...config, backend: { ...backend, network: "host" } }),
    ).toThrow();
    expect(() =>
      parseSandboxConfig({ ...config, backend: { ...backend, imageSha256: "unverified" } }),
    ).toThrow();
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
