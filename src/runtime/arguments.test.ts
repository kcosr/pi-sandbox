import { describe, expect, it } from "vitest";

import {
  createManagedPiArguments,
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

  it("mirrors Pi's user-controlled tool selection for session-start registration", () => {
    const enabled = new Set(["read", "write", "bash"]);
    expect(selectManagedActiveTools([], enabled)).toEqual(["read", "write", "bash"]);
    expect(selectManagedActiveTools(["--tools", "read,bash"], enabled)).toEqual(["read", "bash"]);
    expect(selectManagedActiveTools(["-xt", "write"], enabled)).toEqual(["read", "bash"]);
    expect(selectManagedActiveTools(["--no-tools"], enabled)).toEqual([]);
  });
});
