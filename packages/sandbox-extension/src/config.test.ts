import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { readSandboxConfig, parseSandboxConfig } from "./config.js";

const config = {
  version: 6,
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
      { ...config, version: 4 },
      { ...config, version: 5 },
      { ...config, requirePermissions: undefined },
      { ...config, requirePermissions: "true" },
      { ...config, backend: { kind: "automatic", environment: {} } },
      { ...config, tools: {} },
      { ...config, tools: { read: { mode: "allow", sessionGrant: "never" } } },
      { ...config, backend: { kind: "direct", environment: { SECRET: 42 } } },
    ])
      expect(() => parseSandboxConfig(input)).toThrow();
  });
  it("admits explicit Seatbelt policy and rejects unsupported authority or lifecycle fields", () => {
    const backend = {
      kind: "seatbelt",
      network: "none",
      cwdWritable: false,
      deniedPaths: ["/Users/alice/private"],
      environment: { PROJECT: "demo" },
    };
    const parsed = parseSandboxConfig({ ...config, backend });
    expect(parsed.backend).toEqual(backend);
    if (parsed.backend.kind !== "seatbelt") throw new Error("Expected Seatbelt");
    expect(Object.isFrozen(parsed.backend.deniedPaths)).toBe(true);
    for (const patch of [
      { network: "local" },
      { processLifetime: "command" },
      { processLifetime: "sandbox" },
      { hiddenPaths: [] },
      { executable: "/tmp/sandbox-exec" },
      { runtime: "/tmp/node" },
      { cwdWritable: "true" },
      { deniedPaths: ["/private", "/private"] },
      { deniedPaths: ["relative"] },
      { deniedPaths: Array.from({ length: 64 }, (_, i) => `/private/${i}`) },
    ])
      expect(() => parseSandboxConfig({ ...config, backend: { ...backend, ...patch } })).toThrow();
  });
  it("admits one common optional timeout cap and rejects obsolete backend lifetime", () => {
    for (const maximumTimeoutMs of [0.5, 1, 60_000, 3_600_000, 2_147_483_647])
      expect(parseSandboxConfig({ ...config, maximumTimeoutMs }).maximumTimeoutMs).toBe(
        maximumTimeoutMs,
      );
    for (const maximumTimeoutMs of [undefined, null, 0, -1, Infinity, NaN, 2_147_483_648, "1000"])
      expect(() => parseSandboxConfig({ ...config, maximumTimeoutMs })).toThrow("maximumTimeoutMs");
    const backend = {
      kind: "bubblewrap",
      executable: "/usr/bin/bwrap",
      runtime: "/usr/bin/node",
      network: "none",
      cwdWritable: true,
      hiddenPaths: [],
      environment: {},
    };
    expect(
      parseSandboxConfig({ ...config, backend, maximumTimeoutMs: 3_600_000 }).maximumTimeoutMs,
    ).toBe(3_600_000);
    for (const processLifetime of ["command", "sandbox"])
      expect(() =>
        parseSandboxConfig({ ...config, backend: { ...backend, processLifetime } }),
      ).toThrow("configuration keys");
  });
  it("keeps managed command PATH configuration out of standalone JSON", () => {
    for (const field of ["commandPathPrepend", "command_path_prepend"]) {
      expect(() => parseSandboxConfig({ ...config, [field]: ["/opt/libexec"] })).toThrow();
      for (const backend of [
        config.backend,
        { kind: "seatbelt", network: "none", cwdWritable: true, deniedPaths: [], environment: {} },
        {
          kind: "bubblewrap",
          executable: "/usr/bin/bwrap",
          runtime: "/usr/bin/node",
          network: "none",
          cwdWritable: true,
          hiddenPaths: [],
          environment: {},
        },
      ])
        expect(() =>
          parseSandboxConfig({ ...config, backend: { ...backend, [field]: ["/opt/libexec"] } }),
        ).toThrow();
    }
  });
  it("rejects removed VM ownership and controller attachments", () => {
    expect(() => parseSandboxConfig({ ...config, backend: { kind: "smolvm" } })).toThrow(
      "Unsupported sandbox backend",
    );
    expect(() =>
      parseSandboxConfig({ version: 6, mode: "attached", attachment: {}, userBash: false }),
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
