import { describe, expect, it } from "vitest";
import {
  uniqueMachineName,
  validMachineName,
  validateNamePrefix,
  validateSmolvmSocketPaths,
  registryIdentity,
} from "./registry.js";

describe("generated machine name hostname bound", () => {
  it("keeps the complete random suffix within 64 bytes at the 31-character prefix boundary", () => {
    const prefix = "p".repeat(31);
    const name = uniqueMachineName(prefix);
    expect(Buffer.byteLength(name)).toBe(64);
    expect(name).toMatch(new RegExp(`^${prefix}-[a-f0-9]{32}$`, "u"));
    expect(uniqueMachineName(prefix)).not.toBe(name);
  });
  it("rejects longer or non-ASCII prefixes instead of truncating their labels or random suffixes", () => {
    for (const prefix of ["p".repeat(32), "p".repeat(95), "é"])
      expect(() => validateNamePrefix(prefix)).toThrow("smolvm_name_prefix_invalid");
  });
  it("continues accepting unrelated upstream records through the full 128-character limit", () => {
    expect(validMachineName("f".repeat(64))).toBe(true);
    expect(validMachineName("f".repeat(128))).toBe(true);
    expect(validMachineName("f".repeat(129))).toBe(false);
  });
});

describe("ordinary registry socket paths", () => {
  it("resolves the native account registry separately from the settings file", async () => {
    const identity = await registryIdentity({
      HOME: "/smolvm-test-account",
      XDG_DATA_HOME: "/smolvm-test-data",
      XDG_CACHE_HOME: "/smolvm-test-cache",
      SMOLVM_CONFIG: "/smolvm-test-settings/config.toml",
    });
    expect(identity).toEqual({
      home: "/smolvm-test-account",
      dataDirectory:
        process.platform === "darwin"
          ? "/smolvm-test-account/Library/Application Support/smolvm"
          : "/smolvm-test-data/smolvm",
      cacheDirectory:
        process.platform === "darwin"
          ? "/smolvm-test-account/Library/Caches"
          : "/smolvm-test-cache",
      configFile: "/smolvm-test-settings/config.toml",
    });
  });
  it("accepts ordinary short shared cache paths", () => {
    expect(() =>
      validateSmolvmSocketPaths({ HOME: "/home/user", XDG_CACHE_HOME: "/cache" }),
    ).not.toThrow();
  });
  it("rejects an upstream socket that would exceed the platform limit before native creation", () => {
    const long = "/" + "x".repeat(100);
    expect(() => validateSmolvmSocketPaths({ HOME: long, XDG_CACHE_HOME: long })).toThrow(
      "smolvm_native_socket_path_too_long",
    );
  });
});
