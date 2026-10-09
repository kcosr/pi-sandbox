import { describe, expect, it, vi } from "vitest";
import type { McpHttpServerConfig, McpStdioServerConfig } from "../domain/index.js";
import { resolveMcpServers } from "./resolve.js";

const base = {
  enabled: true,
  exposure: "direct",
  timeoutMs: 60000,
  defaultPolicy: { mode: "ask", sessionGrant: "never", audit: false },
  toolRules: [],
} as const;
const http: McpHttpServerConfig = {
  ...base,
  id: "docs",
  transport: "http",
  url: "https://example.com/mcp/{{username}}?uid={{uid}}",
  headers: {},
  headersFromEnv: { Authorization: "TOKEN" },
};
const stdio: McpStdioServerConfig = {
  ...base,
  id: "local",
  transport: "stdio",
  command: "/opt/mcp/server",
  args: ["--stdio"],
  env: { CACHE: "~/cache/{{uid}}" },
  envFromEnv: { SERVICE_TOKEN: "TOKEN" },
};
const account = () => ({ username: "alice+team", uid: 1001, homeDirectory: "/home/alice" });
const executable = vi.fn(async () => {});

describe("MCP per-account resolution", () => {
  it("resolves URL components and passes complete explicit credential values", async () => {
    const [server] = await resolveMcpServers(
      { servers: { docs: http } },
      { TOKEN: "Bearer secret" },
      account,
      executable,
    );
    expect(server).toMatchObject({
      status: "ready",
      url: "https://example.com/mcp/alice%2Bteam?uid=1001",
      headers: { Authorization: "Bearer secret" },
    });
  });
  it("projects stdio variables with OS identity and no ambient credential inheritance", async () => {
    const [server] = await resolveMcpServers(
      { servers: { local: stdio } },
      { TOKEN: "secret", PROVIDER_TOKEN: "private", HOME: "/spoof", USER: "spoof" },
      account,
      executable,
    );
    expect(server!.environment).toMatchObject({
      SERVICE_TOKEN: "secret",
      HOME: "/home/alice",
      USER: "alice+team",
      CACHE: "/home/alice/cache/1001",
    });
    expect(server!.environment).not.toHaveProperty("PROVIDER_TOKEN");
    expect(server!.environment).not.toHaveProperty("TOKEN");
    expect(executable).toHaveBeenCalledWith("/opt/mcp/server");
  });
  it("captures references once without interpreting template-looking secrets", async () => {
    const env = { TOKEN: "{{username}}~!command" };
    const [server] = await resolveMcpServers({ servers: { docs: http } }, env, account, executable);
    env.TOKEN = "changed";
    expect(server!.headers!.Authorization).toBe("{{username}}~!command");
    expect(Object.isFrozen(server!.headers)).toBe(true);
  });
  it.each([undefined, "", "secret\r\nInjected: value", "x".repeat(16385)])(
    "isolates invalid credential %s to its server",
    async (value) => {
      const servers = await resolveMcpServers(
        { servers: { docs: http, public: { ...http, id: "public", headersFromEnv: {} } } },
        { TOKEN: value },
        account,
        executable,
      );
      expect(servers.map((server) => server.status)).toEqual(["credentials-unavailable", "ready"]);
      expect(servers[0]).not.toHaveProperty("headers");
    },
  );
  it("does not resolve disabled server identities, credentials or executables", async () => {
    const identity = vi.fn(() => {
      throw new Error("must not resolve");
    });
    const check = vi.fn();
    const servers = await resolveMcpServers(
      { servers: { docs: { ...http, enabled: false }, local: { ...stdio, enabled: false } } },
      {},
      identity,
      check,
    );
    expect(servers.every((server) => server.status === "disabled")).toBe(true);
    expect(identity).not.toHaveBeenCalled();
    expect(check).not.toHaveBeenCalled();
  });
  it.each(["http", "stdio"])(
    "fails operational startup for a missing trusted account needed by %s",
    async (transport) => {
      await expect(
        resolveMcpServers(
          { servers: { selected: transport === "http" ? http : stdio } },
          { TOKEN: "secret" },
          () => {
            throw new Error("sensitive OS lookup metadata");
          },
          executable,
        ),
      ).rejects.toThrow("Unable to resolve the invoking account identity");
    },
  );

  it("keeps account lookup lazy for literal HTTP endpoints", async () => {
    const identity = vi.fn(() => {
      throw new Error("not needed");
    });
    const [server] = await resolveMcpServers(
      { servers: { docs: { ...http, url: "https://example.com/mcp" } } },
      { TOKEN: "secret" },
      identity,
      executable,
    );
    expect(server!.status).toBe("ready");
    expect(identity).not.toHaveBeenCalled();
  });

  it.each(["http", "stdio"])(
    "classifies %s combined reference overflow as credentials-unavailable",
    async (transport) => {
      const literals = Object.fromEntries(
        Array.from({ length: 3 }, (_, i) => [`FIELD_${i}`, "x".repeat(16384)]),
      );
      const selected =
        transport === "http" ? { ...http, headers: literals } : { ...stdio, env: literals };
      const [server] = await resolveMcpServers(
        { servers: { selected } },
        { TOKEN: "y".repeat(16384) },
        account,
        executable,
      );
      expect(server!.status).toBe("credentials-unavailable");
      expect(server).not.toHaveProperty("headers");
      expect(server).not.toHaveProperty("environment");
    },
  );

  it("classifies expansion overflow separately from credential references", async () => {
    const [server] = await resolveMcpServers(
      { servers: { local: { ...stdio, env: { CACHE: "~/" + "a".repeat(16382) } } } },
      { TOKEN: "secret" },
      account,
      executable,
    );
    expect(server!.status).toBe("configuration-value-unavailable");
  });

  it("fails startup for a missing administrator-selected executable", async () => {
    await expect(
      resolveMcpServers({ servers: { local: stdio } }, { TOKEN: "secret" }, account, () =>
        Promise.reject(new Error("host error secret")),
      ),
    ).rejects.toThrow("configured executable is unavailable");
  });
  it("degrades a per-account URL failure without returning account data", async () => {
    const [server] = await resolveMcpServers(
      { servers: { docs: http } },
      { TOKEN: "secret" },
      () => ({ ...account(), username: ".." }),
      executable,
    );
    expect(server).toEqual({ policy: http, status: "configuration-value-unavailable" });
  });
});
