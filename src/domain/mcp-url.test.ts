import { describe, expect, it } from "vitest";
import { validateMcpUrl } from "./mcp-url.js";

describe("literal MCP URLs", () => {
  it.each([
    "https://mcp.example/mcp?user=alice&uid=1001&literal=a%2fb",
    "HTTPS://mcp.example/mcp?user=alice",
    "HTTP://LOCALHOST:8080/mcp?uid=1001",
    "http://localhost:8080/mcp?uid=1001",
    "http://127.0.0.1/mcp",
    "http://[::1]:8080/mcp",
    "https://mcp.example/%7B%7Busername%7D%7D?value=%7b%7buid%7d%7d",
    "https://mcp.example/mcp?same=one&same=two&empty=&flag&encoded=%26%3D%23",
    "https://mcp.example/%FF/%C3/.%FF/%2e%C3?literal=%ff",
  ])("accepts a literal endpoint with ordinary URL data: %s", (value) =>
    expect(() => validateMcpUrl(value)).not.toThrow(),
  );
  it.each([
    "http://remote.example/mcp",
    "HTTP://remote.example/mcp",
    "http://127.1/mcp",
    "http://2130706433/mcp",
    "http://localhost./mcp",
    "http://0x7f000001/mcp",
    "ftp://mcp.example/mcp",
    "https://user:secret@mcp.example/mcp",
    "https://@mcp.example/mcp",
    "https://mcp.example/mcp#x",
    "https://mcp.example/mcp#",
    "https://{{username}}.example/mcp",
    "https://mcp.example:{{uid}}/mcp",
    "https://mcp.example/mcp/{{username}}",
    "https://mcp.example/mcp?uid={{uid}}",
    "https://mcp.example/mcp?{{username}}=alice",
    "https://mcp.example/mcp?{{uid}}",
    "https://mcp.example/mcp?user={{other}}",
    "https://mcp.example/mcp?user={{{{username}}}}",
    "https://mcp.example/mcp?user={{username",
    "https://mcp.example/./mcp",
    "https://mcp.example/../mcp",
    "https://mcp.example/%2e%2e/mcp",
    "https://mcp.example/.%2E/mcp",
    "https://mcp.example/%2E./mcp",
    "https://mcp.example/%2e/mcp",
    "https://mcp.example/mcp%xx",
    "https://mcp.example/mcp?invalid=%",
    "https://mcp.example/a\\b",
    "https://mcp.example/a\nb",
  ])("rejects macros, malformed URLs and forbidden endpoints: %s", (value) =>
    expect(() => validateMcpUrl(value)).toThrow(),
  );
  it("bounds literal URLs by UTF-8 bytes", () => {
    expect(() => validateMcpUrl(`https://mcp.example/${"é".repeat(2040)}`)).toThrow();
  });
});
