import { describe, expect, it, vi } from "vitest";
import { expandAccountValue, validateAccountTemplate } from "./account-macros.js";
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
