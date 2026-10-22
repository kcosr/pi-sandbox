import { describe, expect, it } from "vitest";

import { parseSandboxArguments } from "./config-arguments.js";
import { assertRuntimeUser } from "./user.js";

const managed = { configPath: "/etc/pi-sandbox/config.toml", allowConfigOverride: false };
const configurable = { ...managed, allowConfigOverride: true };

describe("build-controlled configuration arguments", () => {
  it("uses the compiled policy when no override is supplied", () => {
    for (const layout of [managed, configurable]) {
      expect(parseSandboxArguments(["--model", "local/example"], layout)).toEqual({
        configPath: managed.configPath,
        piArgs: ["--model", "local/example"],
      });
    }
  });

  it.each([
    ["--config", "/tmp/policy.toml"],
    ["--config=/tmp/policy.toml"],
    ["--help", "--config", "/tmp/policy.toml"],
  ])("rejects config selection in managed builds: %j", (...args) => {
    expect(() => parseSandboxArguments(args, managed)).toThrow(
      "This build does not permit --config",
    );
  });

  it.each([["--config", "policy.toml"], ["--config=policy.toml"]])(
    "resolves the prefix relative to the launch directory: %j",
    (...prefix) => {
      expect(parseSandboxArguments([...prefix, "auth", "check"], configurable, "/srv/lab")).toEqual(
        {
          configPath: "/srv/lab/policy.toml",
          piArgs: ["auth", "check"],
        },
      );
    },
  );

  it.each([
    ["--config"],
    ["--config="],
    ["--config", ""],
    ["--config", "--help"],
    ["--config", "bad\0path"],
  ])("rejects a missing or invalid path: %j", (...args) => {
    expect(() => parseSandboxArguments(args, configurable)).toThrow(
      "--config requires a TOML file path",
    );
  });

  it.each([
    ["--config", "first.toml", "--config=second.toml"],
    ["--model", "local/example", "--config", "policy.toml"],
  ])("rejects repeated or misplaced overrides: %j", (...args) => {
    expect(() => parseSandboxArguments(args, configurable)).toThrow(
      "--config must appear once, before Pi arguments",
    );
  });

  it("leaves literal prompt arguments after -- untouched", () => {
    expect(parseSandboxArguments(["--", "--config", "policy.toml"], managed)).toEqual({
      configPath: managed.configPath,
      piArgs: ["--", "--config", "policy.toml"],
    });
  });

  it("preserves managed argument restrictions after consuming the prefix", () => {
    for (const args of [["install", "unsafe"], ["mcp"], ["--extension", "unsafe.ts"]]) {
      expect(() =>
        parseSandboxArguments(["--config", "policy.toml", ...args], configurable),
      ).toThrow("does not permit the Pi argument");
    }
  });

  it("preserves the root boundary while allowing explicit administrative validation", () => {
    const validation = parseSandboxArguments(
      ["--config", "policy.toml", "--validate-installation"],
      configurable,
    );
    expect(() => assertRuntimeUser(validation.piArgs, 0)).not.toThrow();
    const interactive = parseSandboxArguments(["--config", "policy.toml"], configurable);
    expect(() => assertRuntimeUser(interactive.piArgs, 0)).toThrow("refusing to run as root");
  });
});

describe("workspace mode arguments", () => {
  it.each([
    ["--writable-cwd", "read_write"],
    ["--read-only-cwd", "read_only"],
  ] as const)("consumes %s before passing arguments to Pi", (flag, mode) => {
    expect(parseSandboxArguments([flag, "--model", "local/example"], managed)).toEqual({
      configPath: managed.configPath,
      workspaceMode: mode,
      piArgs: ["--model", "local/example"],
    });
    expect(
      parseSandboxArguments(["--config", "policy.toml", flag], configurable, "/srv/lab"),
    ).toEqual({
      configPath: "/srv/lab/policy.toml",
      workspaceMode: mode,
      piArgs: [],
    });
  });
  it.each([
    ["--writable-cwd", "--read-only-cwd"],
    ["--read-only-cwd", "--read-only-cwd"],
    ["--model", "local/example", "--writable-cwd"],
    ["--writable-cwd=true"],
  ])("rejects duplicate, conflicting or misplaced selection: %j", (...args) => {
    expect(() => parseSandboxArguments(args, managed)).toThrow("CWD mode must appear once");
  });
  it.each(["--validate-installation", "--print-execution-backend", "--version", "-v"])(
    "does not attach workspace selection to %s",
    (command) => {
      expect(() => parseSandboxArguments(["--read-only-cwd", command], managed)).toThrow(
        "maintenance",
      );
    },
  );
  it("keeps option values and post-separator text as data", () => {
    for (const flag of ["--writable-cwd", "--read-only-cwd", "--config=example"]) {
      for (const args of [
        ["--system-prompt", flag],
        ["--", flag],
      ]) {
        expect(parseSandboxArguments(args, managed)).toEqual({
          configPath: managed.configPath,
          piArgs: args,
        });
      }
    }
  });
  it("preserves managed restrictions after mode selection", () => {
    expect(() =>
      parseSandboxArguments(["--writable-cwd", "--extension", "unsafe.ts"], managed),
    ).toThrow("does not permit");
  });
});
