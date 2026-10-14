import { describe, expect, it, vi } from "vitest";
import { expandAccountValue, validateAccountTemplate } from "./account-macros.js";
import { expandManagedHomePaths } from "./home-expansion.js";
const alice = () => ({ username: "alice", uid: 1001, homeDirectory: "/accounts/alice" });
const machineId = "12345678-9ABC-5DEF-8123-456789ABCDEF";

describe("account templates", () => {
  it("expands machine IDs independently of account lookup and reads once per value", () => {
    const identity = vi.fn(alice);
    const machine = vi.fn(() => machineId);
    expect(expandAccountValue("{{machine_id}}/{{machine_id}}", identity, true, machine)).toBe(
      `${machineId}/${machineId}`,
    );
    expect(machine).toHaveBeenCalledOnce();
    expect(identity).not.toHaveBeenCalled();
  });
  it("keeps the machine resolver lazy for literal, account-only, and escaped values", () => {
    const machine = vi.fn(() => {
      throw new Error("Machine ID unavailable");
    });
    const identity = vi.fn(alice);
    expect(expandAccountValue("literal", identity, true, machine)).toBe("literal");
    expect(expandAccountValue("~/{{username}}/{{uid}}", identity, true, machine)).toBe(
      "/accounts/alice/alice/1001",
    );
    expect(expandAccountValue("{{{{machine_id}}}}", identity, true, machine)).toBe(
      "{{machine_id}}",
    );
    expect(machine).not.toHaveBeenCalled();
  });
  it("validates a machine template without lookup but requires a resolver to expand it", () => {
    expect(() => validateAccountTemplate("{{machine_id}}")).not.toThrow();
    expect(() => expandAccountValue("{{machine_id}}", alice)).toThrow("machine ID resolver");
    const unavailable = () => {
      throw new Error("Machine ID unavailable");
    };
    expect(() => expandAccountValue("{{machine_id}}", alice, false, unavailable)).toThrow(
      "Machine ID unavailable",
    );
  });
  it("never recursively expands a machine replacement", () => {
    const identity = vi.fn(alice);
    expect(expandAccountValue("{{machine_id}}", identity, true, () => "{{username}}")).toBe(
      "{{username}}",
    );
    expect(identity).not.toHaveBeenCalled();
  });
  it("expands all configured scopes and masks from one canonical account", () => {
    const identity = vi.fn(alice);
    const result = expandManagedHomePaths(
      { cwdWritable: true, deniedPaths: [], hiddenPaths: ["/srv/{{uid}}/{{username}}", "~/.ssh"] },
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
        { cwdWritable: true, deniedPaths: [], hiddenPaths: ["/home/{{username}}", "/home/alice"] },
        { pi: {}, sandbox: {}, extensions: {} },
        alice,
      ),
    ).toThrow("unique");
    expect(() =>
      expandManagedHomePaths(
        { cwdWritable: true, deniedPaths: [], hiddenPaths: ["/{{username}}"] },
        { pi: {}, sandbox: {}, extensions: {} },
        () => ({ ...alice(), username: "proc" }),
      ),
    ).toThrow("private system");
  });
});
