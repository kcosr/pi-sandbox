import { describe, expect, it } from "vitest";

import { parseSandboxArguments } from "./config-arguments.js";
import { assertRuntimeUser } from "./user.js";

const managed = {
  configuration: {
    source: "local" as const,
    configDir: "/etc/pi-sandbox",
    configPath: "/etc/pi-sandbox/config.toml",
    defaultModelsPath: "/etc/pi-sandbox/models.json",
    allowConfigOverride: false,
  },
};
const configurable = { configuration: { ...managed.configuration, allowConfigOverride: true } };

describe("build-controlled configuration arguments", () => {
  it("uses the compiled policy when no override is supplied", () => {
    for (const layout of [managed, configurable]) {
      expect(parseSandboxArguments(["--model", "local/example"], layout)).toEqual({
        configPath: managed.configuration.configPath,
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
      configPath: managed.configuration.configPath,
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

describe("workspace launch selection", () => {
  it.each([["--workspace-mode", "sandbox"], ["--workspace-mode=sandbox"]])(
    "consumes one selector before Pi arguments: %j",
    (...prefix) => {
      expect(parseSandboxArguments([...prefix, "--mode", "rpc"], managed)).toEqual({
        configPath: managed.configuration.configPath,
        workspaceMode: "sandbox",
        piArgs: ["--mode", "rpc"],
      });
      expect(
        parseSandboxArguments(["--config", "/tmp/policy.toml", ...prefix], configurable),
      ).toMatchObject({
        configPath: "/tmp/policy.toml",
        workspaceMode: "sandbox",
        piArgs: [],
      });
    },
  );

  it.each([
    ["--workspace-mode"],
    ["--workspace-mode="],
    ["--workspace-mode", "Host"],
    ["--workspace-mode", "../host"],
    ["--workspace-mode", ""],
    ["--workspace-mode", "x".repeat(33)],
    ["--workspace-mode", "host", "--workspace-mode=sandbox"],
    ["--workspace-mode", "host", "--config", "/tmp/policy.toml"],
    ["prompt", "--workspace-mode=host"],
    ["--mode", "--workspace-mode=host"],
    ["--name", "--", "--workspace-mode=host"],
  ])("rejects malformed or misplaced selection: %j", (...args) => {
    expect(() => parseSandboxArguments(args, configurable)).toThrow();
  });

  it.each([
    "--version",
    "--validate-installation",
    "--print-build-capabilities",
    "--pi-sandbox-internal-worker",
    "--pi-sandbox-internal-export-reader",
  ])("rejects selectors with metadata/private operation %s before startup", (operation) => {
    expect(() => parseSandboxArguments(["--workspace-mode=host", operation], managed)).toThrow(
      "cannot be combined",
    );
  });

  it.each([
    ["--system-prompt", "--workspace-mode=sandbox"],
    ["--name", "--config=literal"],
    ["--", "--workspace-mode", "sandbox"],
    ["--", "--list-workspace-modes"],
    ["--system-prompt", "--list-workspace-modes"],
    ["A prompt containing --workspace-mode=host text"],
  ])("preserves literal Pi values and prompt text: %j", (...args) => {
    expect(parseSandboxArguments(args, managed)).toEqual({
      configPath: managed.configuration.configPath,
      piArgs: args,
    });
  });

  it("leaves optional-extension switches in their existing positions", () => {
    expect(
      parseSandboxArguments(
        ["--workspace-mode=host", "prompt", "--enable-extension", "git"],
        managed,
      ).piArgs,
    ).toEqual(["prompt", "--enable-extension", "git"]);
  });

  it("admits standalone listing with the normal root-user boundary", () => {
    const parsed = parseSandboxArguments(
      ["--config", "/tmp/policy.toml", "--list-workspace-modes"],
      configurable,
    );
    expect(parsed).toEqual({
      configPath: "/tmp/policy.toml",
      piArgs: ["--list-workspace-modes"],
      listWorkspaceModes: true,
    });
    expect(() => assertRuntimeUser(parsed.piArgs, 0)).toThrow("refusing to run as root");
  });

  it.each([
    ["--list-workspace-modes", "--list-workspace-modes"],
    ["--workspace-mode=host", "--list-workspace-modes"],
    ["--list-workspace-modes", "--mode", "rpc"],
    ["--list-workspace-modes", "--version"],
    ["--list-workspace-modes=true"],
    ["prompt", "--list-workspace-modes"],
  ])("rejects ambiguous listing: %j", (...args) => {
    expect(() => parseSandboxArguments(args, managed)).toThrow(
      "--list-workspace-modes accepts only",
    );
  });
});

describe("immutable service source", () => {
  const service = {
    configuration: {
      source: "service" as const,
      endpoint: {
        transport: "https" as const,
        url: "https://service.invalid/v1/service",
        basicUsername: "fixture",
        basicPassword: "x".repeat(32),
        sendMachineId: false,
      },
    },
  };
  it("has no local path or runtime source selector", () => {
    expect(parseSandboxArguments(["--help"], service)).toEqual({ piArgs: ["--help"] });
    for (const args of [
      ["--config", "/tmp/config.toml"],
      ["--help", "--config=/tmp/config.toml"],
      ["--api-key", "personal"],
      ["--api-key=personal"],
    ])
      expect(() => parseSandboxArguments(args, service)).toThrow();
  });
  it("keeps help mode selection and rejects it for every administrative command", () => {
    expect(parseSandboxArguments(["--workspace-mode", "sandbox", "--help"], service)).toEqual({
      piArgs: ["--help"],
      workspaceMode: "sandbox",
    });
    for (const command of [
      "--version",
      "--validate-installation",
      "--validate-service",
      "--validate-bootstrap",
      "--print-build-capabilities",
    ])
      expect(() =>
        parseSandboxArguments(["--workspace-mode", "sandbox", command], service),
      ).toThrow("cannot be combined");
  });
  it("permits only offline validation and capability queries as root", () => {
    for (const command of [
      "--validate-installation",
      "--validate-bootstrap",
      "--print-build-capabilities",
    ])
      expect(() => assertRuntimeUser([command], 0)).not.toThrow();
    for (const command of ["--validate-service", "--help", "--list-workspace-modes"])
      expect(() => assertRuntimeUser([command], 0)).toThrow("refusing to run as root");
  });
});
