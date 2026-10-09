import { describe, expect, it, vi } from "vitest";
import {
  expandAccountValue,
  expandMcpUrl,
  validateAccountTemplate,
  validateMcpUrlTemplate,
} from "./account-macros.js";
import { expandManagedHomePaths } from "./home-expansion.js";
const alice = () => ({ username: "alice", uid: 1001, homeDirectory: "/accounts/alice" });

describe("account templates", () => {
  it("expands all configured scopes and masks from one canonical account", () => {
    const identity = vi.fn(alice);
    const result = expandManagedHomePaths(
      { cwdWritable: true, hiddenPaths: ["/srv/{{uid}}/{{username}}", "~/.ssh"] },
      {
        pi: { USER_ROUTE: "{{username}}/{{uid}}" },
        sandbox: { CACHE: "~/{{uid}}" },
        extensions: { service: { ACCOUNT: "{{username}}" } },
      },
      identity,
    );
    expect(result.filesystem.hiddenPaths).toEqual(["/accounts/alice/.ssh", "/srv/1001/alice"]);
    expect(result.environment).toEqual({
      pi: { USER_ROUTE: "alice/1001" },
      sandbox: { CACHE: "/accounts/alice/1001" },
      extensions: { service: { ACCOUNT: "alice" } },
    });
    expect(identity).toHaveBeenCalledOnce();
  });
  it("never recursively templates replacements or escaped braces", () => {
    const identity = vi.fn(() => ({
      username: "{{uid}}",
      uid: 1001,
      homeDirectory: "/{{username}}",
    }));
    expect(expandAccountValue("~/{{username}}/{{uid}}", identity)).toBe(
      "/{{username}}/{{uid}}/1001",
    );
    const unused = vi.fn(alice);
    expect(expandAccountValue("{{{{username}}}}", unused)).toBe("{{username}}");
    expect(unused).not.toHaveBeenCalled();
  });
  it.each(["{{unknown}}", "{{username", "{{ username }}", "value}}", "{{{username}}}"])(
    "rejects malformed syntax %s",
    (value) => {
      expect(() => validateAccountTemplate(value)).toThrow();
    },
  );
  it("rejects duplicate and reserved masks produced by macros", () => {
    expect(() =>
      expandManagedHomePaths(
        { cwdWritable: true, hiddenPaths: ["/home/{{username}}", "/home/alice"] },
        { pi: {}, sandbox: {}, extensions: {} },
        alice,
      ),
    ).toThrow("unique");
    expect(() =>
      expandManagedHomePaths(
        { cwdWritable: true, hiddenPaths: ["/{{username}}"] },
        { pi: {}, sandbox: {}, extensions: {} },
        () => ({ ...alice(), username: "proc" }),
      ),
    ).toThrow("private system");
  });
});

describe("MCP URL templates", () => {
  it("preserves literal parameters and percent escapes while encoding each replacement", () => {
    const account = () => ({ ...alice(), username: "a/b?&=é#%" });
    expect(
      expandMcpUrl(
        "https://mcp.example/mcp/{{username}}?user={{username}}&uid={{uid}}&literal=%2f&other=x",
        account,
      ),
    ).toBe(
      "https://mcp.example/mcp/a%2Fb%3F%26%3D%C3%A9%23%25?user=a%2Fb%3F%26%3D%C3%A9%23%25&uid=1001&literal=%2f&other=x",
    );
  });
  it.each([
    "https://mcp.example/mcp?user={{username}}",
    "HTTPS://mcp.example/mcp?user={{username}}",
    "HTTP://LOCALHOST:8080/mcp?uid={{uid}}",
    "http://localhost:8080/mcp?uid={{uid}}",
    "http://127.0.0.1/mcp",
    "http://[::1]:8080/mcp",
  ])("accepts %s without looking up installation identity", (value) =>
    expect(() => validateMcpUrlTemplate(value)).not.toThrow(),
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
    "https://{{username}}.example/mcp",
    "https://mcp.example:{{uid}}/mcp",
    "https://mcp.example/mcp?{{username}}=alice",
    "https://mcp.example/mcp?{{uid}}",
    "https://mcp.example/mcp?user={{other}}",
    "https://mcp.example/../mcp",
    "https://mcp.example/%2e%2e/mcp",
    "https://mcp.example/mcp%xx",
    "https://mcp.example/a\\b",
    "https://mcp.example/a\nb",
  ])("rejects invalid or authority-changing template %s", (value) =>
    expect(() => validateMcpUrlTemplate(value)).toThrow(),
  );
  it("rejects dot segments after substitution and overlong expanded URLs", () => {
    for (const username of [".", ".."])
      expect(() =>
        expandMcpUrl("https://mcp.example/{{username}}/mcp", () => ({ ...alice(), username })),
      ).toThrow("dot segments");
    expect(() =>
      expandMcpUrl(`https://mcp.example/${"x".repeat(4050)}/{{username}}`, () => ({
        ...alice(),
        username: "a".repeat(256),
      })),
    ).toThrow("too long");
  });
});
