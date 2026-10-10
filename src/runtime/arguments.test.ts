import { describe, expect, it } from "vitest";

import {
  createManagedPiArguments,
  isManagedMcpSelected,
  isManagedToolSelected,
  selectManagedActiveTools,
  UnsafeManagedArgumentError,
  validateManagedArguments,
} from "./arguments.js";

describe("managed Pi arguments", () => {
  it("forces offline startup, disables discovery, and disables stock tools", () => {
    expect(createManagedPiArguments(["--model", "managed/example"])).toEqual([
      "--offline",
      "--no-extensions",
      "--no-builtin-tools",
      "--model",
      "managed/example",
    ]);
  });

  it.each([
    ["--extension", "/tmp/unsafe.ts"],
    ["-e", "/tmp/unsafe.ts"],
    ["--extension=/tmp/unsafe.ts"],
    ["--no-extensions"],
    ["--no-builtin-tools"],
    ["--offline"],
  ])("rejects caller control of trusted loading: %j", (...args) => {
    expect(() => validateManagedArguments(args)).toThrow(UnsafeManagedArgumentError);
  });

  it.each(["config", "install", "list", "mcp", "remove", "uninstall", "update"])(
    "rejects the Pi resource-management command %s",
    (command) => {
      expect(() => validateManagedArguments([command])).toThrow(UnsafeManagedArgumentError);
    },
  );

  it("permits skills, prompt resources, and tool selection", () => {
    expect(() =>
      validateManagedArguments([
        "--skill",
        "/srv/skills/review",
        "--no-skills",
        "--tools",
        "read,bash",
        "--exclude-tools",
        "write",
      ]),
    ).not.toThrow();
    expect(() => validateManagedArguments(["--tools", "+codemode,-bash"])).not.toThrow();
  });

  it.each([
    ["read,+codemode", "tool names cannot be mixed"],
    ["-bash,read", "tool names cannot be mixed"],
    ["+mcp__docs__*", "exact tool names, not patterns"],
    ["-bash*", "exact tool names, not patterns"],
  ])("rejects invalid modifier selection %s", (selection, message) => {
    expect(() => validateManagedArguments(["--tools", selection])).toThrow(message);
    expect(() => isManagedToolSelected(["--tools", selection], "read")).toThrow(message);
  });

  it("suppresses MCP only for an actual --no-mcp option", () => {
    expect(isManagedMcpSelected([])).toBe(true);
    expect(isManagedMcpSelected(["--no-mcp"])).toBe(false);
    expect(isManagedMcpSelected(["--system-prompt", "--no-mcp"])).toBe(true);
    expect(isManagedMcpSelected(["--append-system-prompt", "--no-mcp"])).toBe(true);
    expect(isManagedMcpSelected(["--name", "--no-mcp"])).toBe(true);
    expect(isManagedMcpSelected(["--", "--no-mcp"])).toBe(true);
    expect(isManagedMcpSelected(["--tools", "+codemode", "--no-mcp"])).toBe(false);
  });

  it("does not interpret tool-selection flags inside prompt values or after --", () => {
    const available = new Set(["read", "bash", "codemode"]);
    for (const args of [
      ["--system-prompt", "--no-tools"],
      ["--append-system-prompt", "--tools", "codemode"],
      ["--", "--tools", "codemode"],
    ]) {
      expect(selectManagedActiveTools(args, available)).toEqual(["read", "bash"]);
      expect(isManagedToolSelected(args, "bash")).toBe(true);
    }
  });

  it("permits Pi auth commands", () => {
    expect(() =>
      validateManagedArguments(["auth", "check", "--provider", "managed"]),
    ).not.toThrow();
    expect(createManagedPiArguments(["auth", "check", "--provider", "managed"])).toEqual([
      "auth",
      "check",
      "--provider",
      "managed",
      "--offline",
      "--no-extensions",
      "--no-builtin-tools",
    ]);
  });

  it("keeps CLI availability separate from initial activation", () => {
    const available = new Set(["read", "write", "bash", "codemode"]);
    expect(isManagedToolSelected([], "codemode")).toBe(true);
    expect(selectManagedActiveTools([], available)).toEqual(["read", "write", "bash"]);
    expect(isManagedToolSelected(["--tools", "read,bash"], "codemode")).toBe(false);
    expect(isManagedToolSelected(["--exclude-tools", "codemode"], "codemode")).toBe(false);
    expect(isManagedToolSelected(["--no-tools"], "codemode")).toBe(false);
  });

  it.each([
    { defaults: ["+codemode"], expected: ["read", "write", "bash", "codemode"] },
    { defaults: ["+codemode", "-codemode", "-write"], expected: ["read", "bash"] },
    { defaults: ["codemode", "read"], expected: ["read", "codemode"] },
    { defaults: ["read", "+write", "-read", "+codemode"], expected: ["write", "codemode"] },
    { defaults: ["unknown", "+codemode"], expected: ["codemode"] },
    { defaults: [], expected: [] },
    { defaults: "codemode", expected: [] },
    { defaults: [false, "read"], expected: ["read"] },
  ])("resolves merged defaultTools $defaults", ({ defaults, expected }) => {
    expect(
      selectManagedActiveTools([], new Set(["read", "write", "bash", "codemode"]), defaults),
    ).toEqual(expected);
  });

  it("lets CLI selection replace defaults while keeping exclusions and policy authoritative", () => {
    const available = new Set(["read", "bash", "codemode"]);
    expect(selectManagedActiveTools(["--tools", "codemode,write"], available, ["read"])).toEqual([
      "codemode",
    ]);
    expect(selectManagedActiveTools(["--tools", "read,bash"], available, ["+codemode"])).toEqual([
      "read",
      "bash",
    ]);
    expect(selectManagedActiveTools(["-xt", "codemode,bash"], available, ["+codemode"])).toEqual([
      "read",
    ]);
    expect(selectManagedActiveTools(["-nt", "-t", "codemode"], available, ["+codemode"])).toEqual(
      [],
    );
    expect(selectManagedActiveTools([], new Set(["read"]), ["+codemode"])).toEqual(["read"]);
  });

  it("applies CLI additions and removals to defaults without becoming an allowlist", () => {
    const available = new Set(["read", "write", "bash", "codemode"]);
    const args = ["--tools", "+codemode,-bash"];
    expect(selectManagedActiveTools(args, available)).toEqual(["read", "write", "codemode"]);
    expect(selectManagedActiveTools(args, available, ["read"])).toEqual(["read", "codemode"]);
    expect(isManagedToolSelected(args, "read")).toBe(true);
    expect(isManagedToolSelected(args, "mcp__docs__search")).toBe(true);
    expect(isManagedToolSelected(args, "bash")).toBe(false);
  });

  it("honors ordered final modifiers, including repeated entries", () => {
    const available = new Set(["read", "write", "bash", "codemode"]);
    const args = ["-t", "+write,-write,+write,+codemode,-codemode,-bash,+bash,-bash"];
    expect(selectManagedActiveTools(args, available)).toEqual(["read", "write"]);
    expect(isManagedToolSelected(args, "write")).toBe(true);
    expect(isManagedToolSelected(args, "codemode")).toBe(false);
    expect(isManagedToolSelected(args, "bash")).toBe(false);
    expect(isManagedToolSelected(["-t", "-codemode,+codemode"], "codemode")).toBe(true);
    expect(isManagedToolSelected(["-t", "-mcp__docs__search"], "mcp__docs__search")).toBe(false);
  });

  it("keeps no-tools, exclusions, and the effective policy above additions", () => {
    const available = new Set(["read", "write", "bash", "codemode"]);
    expect(selectManagedActiveTools(["-nt", "-t", "+codemode"], available)).toEqual([]);
    expect(
      selectManagedActiveTools(["-t", "+codemode,+write", "-xt", "code*,write"], available),
    ).toEqual(["read", "bash"]);
    expect(
      selectManagedActiveTools(["-t", "+codemode,+write,+unknown"], new Set(["read", "bash"])),
    ).toEqual(["read", "bash"]);
  });

  it("matches plain allowlist and exclusion patterns without implicitly selecting MCP tools", () => {
    const available = new Set(["read", "git_clone", "codemode", "mcp__docs__search"]);
    const args = ["--tools", "read,git_*,code*"];
    expect(selectManagedActiveTools(args, available)).toEqual(["read", "git_clone", "codemode"]);
    expect(isManagedToolSelected(args, "mcp__docs__search")).toBe(false);
    expect(isManagedToolSelected(["-t", "mcp__docs__*"], "mcp__docs__search")).toBe(true);
    expect(isManagedToolSelected(["-xt", "mcp__docs__*"], "mcp__docs__search")).toBe(false);
    expect(isManagedToolSelected(["-t", "a.b*"], "axb")).toBe(false);
    expect(isManagedToolSelected(["-t", "a.b*"], "a.b_value")).toBe(true);
  });

  it("mirrors Pi's user-controlled tool selection for session-start registration", () => {
    const enabled = new Set(["read", "write", "bash"]);
    expect(selectManagedActiveTools([], enabled)).toEqual(["read", "write", "bash"]);
    expect(selectManagedActiveTools(["--tools", "read,bash"], enabled)).toEqual(["read", "bash"]);
    expect(selectManagedActiveTools(["-xt", "write"], enabled)).toEqual(["read", "bash"]);
    expect(selectManagedActiveTools(["--no-tools"], enabled)).toEqual([]);
  });
});
