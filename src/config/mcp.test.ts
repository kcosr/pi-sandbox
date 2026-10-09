import { readFileSync } from "node:fs";
import { stringify } from "@iarna/toml";
import { describe, expect, it } from "vitest";
import { createManagedExtensionCatalog } from "../managed-extensions/catalog.js";
import { parseConfig } from "./parse.js";
import { parseCodeModeConfig, parseMcpConfig } from "./mcp.js";

const policy = { mode: "ask", session_grant: "offer", audit: true };
const http = {
  enabled: true,
  transport: "http",
  exposure: "direct",
  url: "https://mcp.example/mcp?user=alice&uid=1001&literal=a%2fb",
  default_policy: policy,
};
const stdio = {
  enabled: true,
  transport: "stdio",
  exposure: "direct",
  command: "/opt/mcp/server",
  default_policy: policy,
};
const code = { enabled: true, timeoutMs: 300000 };
const parse = (server: Record<string, unknown>) =>
  parseMcpConfig({ servers: { docs: server } }, code).servers.docs!;

describe("MCP administrative configuration", () => {
  it("requires new top-level sections and schema 10, with packaged features disabled", () => {
    const fixture = readFileSync("config/default/config.toml", "utf8");
    const catalog = createManagedExtensionCatalog([]);
    const config = parseConfig(fixture, "fixture", catalog);
    expect(config.codemode).toEqual({ enabled: false, timeoutMs: 300000 });
    expect(config.mcp.servers).toEqual({});
    expect(() =>
      parseConfig(fixture.replace("config_version = 10", "config_version = 9"), "fixture", catalog),
    ).toThrow("integer 10");
    expect(() =>
      parseConfig(fixture.replace("[mcp.servers]", "[mcp]"), "fixture", catalog),
    ).toThrow("servers is required");
  });
  it("parses HTTP and stdio without resolving identities, credentials, or executables", () => {
    expect(
      parse({
        ...http,
        headers: { "X-Account": "literal" },
        headers_from_env: { Authorization: "TOKEN" },
      }),
    ).toMatchObject({
      id: "docs",
      timeoutMs: 60000,
      headersFromEnv: { Authorization: "TOKEN" },
      defaultPolicy: { mode: "ask", sessionGrant: "offer", audit: true },
    });
    expect(
      parse({
        ...stdio,
        command: "/missing/{{username}}",
        args: ["{{literal}}"],
        env: { CACHE: "~/{{username}}/{{uid}}" },
        env_from_env: { TOKEN: "SOURCE_TOKEN" },
      }),
    ).toMatchObject({
      command: "/missing/{{username}}",
      args: ["{{literal}}"],
      envFromEnv: { TOKEN: "SOURCE_TOKEN" },
    });
  });
  it("preserves ordered complete wildcard policies", () => {
    expect(
      parse({
        ...http,
        tool_rules: [
          { match: "search_*", ...policy },
          { match: "*", mode: "disabled", session_grant: "never", audit: false },
        ],
      }).toolRules,
    ).toEqual([
      { match: "search_*", mode: "ask", sessionGrant: "offer", audit: true },
      { match: "*", mode: "disabled", sessionGrant: "never", audit: false },
    ]);
  });
  it.each([
    { ...http, command: "/usr/bin/server" },
    { ...http, url: "https://mcp.example/{{username}}" },
    { ...http, url: "https://mcp.example/mcp?uid={{uid}}" },
    { ...stdio, url: "https://mcp.example" },
    { ...http, unknown: true },
    { ...http, enabled: "yes" },
    { ...http, exposure: "both" },
    { ...http, timeout_ms: 0 },
    { ...http, timeout_ms: 3600001 },
    { ...http, timeout_ms: 1000.5 },
    { ...http, default_policy: { mode: "ask", audit: false } },
    { ...http, default_policy: { ...policy, mode: "allow" } },
    { ...http, tool_rules: [{ match: "delete_?", ...policy }] },
    { ...http, tool_rules: [{ match: "[a-z]", ...policy }] },
    {
      ...http,
      tool_rules: [
        { match: "x", ...policy },
        { match: "x", ...policy },
      ],
    },
    { ...http, headers: { Authorization: "secret\r\nInjected: true" } },
    { ...http, headers: { Authorization: "Bearer \u0100" } },
    { ...http, headers: { Authorization: "a", authorization: "b" } },
    {
      ...http,
      headers: { Authorization: "literal" },
      headers_from_env: { authorization: "TOKEN" },
    },
    { ...http, headers: { Host: "other.example" } },
    { ...http, headers_from_env: { "Mcp-Session-Id": "TOKEN" } },
    { ...http, headers_from_env: { Authorization: "!command" } },
    { ...stdio, command: "~/server" },
    { ...stdio, command: "/opt/../bin/server" },
    { ...stdio, args: ["x\0y"] },
    { ...stdio, env: { NODE_OPTIONS: "--require=x" } },
    { ...stdio, env_from_env: { LD_PRELOAD: "TOKEN" } },
    { ...stdio, env: { TOKEN: "literal" }, env_from_env: { TOKEN: "SOURCE_TOKEN" } },
    { ...stdio, env: { USER_ROUTE: "{{unsupported}}" } },
  ])("rejects malformed or ambiguous server configuration %#", (value) =>
    expect(() => parse(value)).toThrow(),
  );
  it("rejects exposure without code mode while validating disabled server syntax", () => {
    expect(() =>
      parseMcpConfig(
        { servers: { docs: { ...http, exposure: "codemode" } } },
        { enabled: false, timeoutMs: 300000 },
      ),
    ).toThrow("codemode.enabled");
    expect(() =>
      parseMcpConfig(
        { servers: { docs: { ...http, enabled: false, exposure: "codemode" } } },
        { enabled: false, timeoutMs: 300000 },
      ),
    ).not.toThrow();
    expect(() => parse({ ...http, enabled: false, url: "not-a-url" })).toThrow();
  });
  it("bounds administrative catalogs, maps, rules, argv and configuration size", () => {
    expect(() =>
      parseMcpConfig(
        { servers: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`server${i}`, http])) },
        code,
      ),
    ).toThrow("32 servers");
    expect(() =>
      parse({
        ...http,
        headers: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`X-${i}`, "a"])),
      }),
    ).toThrow("64 entries");
    expect(() =>
      parse({
        ...http,
        tool_rules: Array.from({ length: 257 }, (_, i) => ({ match: `tool${i}`, ...policy })),
      }),
    ).toThrow("256 rules");
    expect(() => parse({ ...stdio, args: Array(128).fill("a") })).toThrow("128-entry");
    expect(() => parse({ ...http, headers: { Authorization: "x".repeat(16 * 1024 + 1) } })).toThrow(
      "invalid value",
    );
    expect(() =>
      parse({
        ...http,
        headers: Object.fromEntries(
          Array.from({ length: 5 }, (_, i) => [`X-${i}`, "a".repeat(16 * 1024)]),
        ),
      }),
    ).toThrow("64 KiB");
    expect(() => parse({ ...stdio, args: ["a".repeat(256 * 1024)] })).toThrow("256 KiB");
  });
  it("rejects account macro syntax in configured scopes before operational resolution", () => {
    const fixture = readFileSync("config/default/config.toml", "utf8");
    const catalog = createManagedExtensionCatalog([]);
    for (const source of [
      fixture.replace("hidden_paths = []", 'hidden_paths = ["/srv/{{unknown}}"]'),
      fixture.replace("[environment.pi]", '[environment.pi]\nTOKEN = "{{unknown}}"'),
    ])
      expect(() => parseConfig(source, "fixture", catalog)).toThrow();
    const source = fixture + "\n" + stringify({ mcp: { servers: { docs: http } } });
    expect(parseConfig(source, "fixture", catalog).mcp.servers.docs!.transport).toBe("http");
  });
});

describe("code-mode configuration", () => {
  it("has one boolean feature gate and bounded overall deadline", () => {
    expect(parseCodeModeConfig({ enabled: true })).toEqual(code);
    expect(parseCodeModeConfig({ enabled: false, timeout_ms: 1000 })).toEqual({
      enabled: false,
      timeoutMs: 1000,
    });
    for (const bad of [
      {},
      { enabled: "true" },
      { enabled: true, mode: "ask" },
      { enabled: true, timeout_ms: -1 },
    ])
      expect(() => parseCodeModeConfig(bad)).toThrow();
  });
});
