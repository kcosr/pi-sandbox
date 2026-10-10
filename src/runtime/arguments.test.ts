import { describe, expect, it } from "vitest";

import {
  createManagedPiArguments,
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

  it("mirrors Pi's user-controlled tool selection for session-start registration", () => {
    const enabled = new Set(["read", "write", "bash"]);
    expect(selectManagedActiveTools([], enabled)).toEqual(["read", "write", "bash"]);
    expect(selectManagedActiveTools(["--tools", "read,bash"], enabled)).toEqual(["read", "bash"]);
    expect(selectManagedActiveTools(["-xt", "write"], enabled)).toEqual(["read", "bash"]);
    expect(selectManagedActiveTools(["--no-tools"], enabled)).toEqual([]);
  });
});
