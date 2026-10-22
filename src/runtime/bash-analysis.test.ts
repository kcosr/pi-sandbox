import { describe, expect, it, vi } from "vitest";

import { TOOL_NAMES, type SandboxConfig } from "../domain/index.js";
import type { BashCommandAnalyzer } from "../permissions/bash/contracts.js";
import { safeSandboxEnvironment } from "../../packages/sandbox-extension/src/runtime/bubblewrap-policy.js";
import {
  bashExecutionContext,
  createConfiguredBashAnalyzer,
  type BashAnalysisRuntime,
} from "./bash-analysis.js";

const toolBundle = { root: "/opt/pi-sandbox/tools", commands: {} };

function runtime(
  backend: SandboxConfig["execution"]["backend"],
  classPolicy = true,
  bundled = true,
): BashAnalysisRuntime {
  const tools = Object.fromEntries(
    TOOL_NAMES.map((name) => [name, { mode: "allow", sessionGrant: "never", audit: false }]),
  ) as Record<string, SandboxConfig["tools"][string]>;
  tools.bash = {
    mode: "deny",
    sessionGrant: "never",
    audit: false,
    ...(classPolicy
      ? { commandClasses: { known_read_only: { mode: "allow", sessionGrant: "never" } } }
      : {}),
  };
  return {
    config: {
      configVersion: 14,
      workspace: {
        mode: "read_write",
        default: "read_write",
        allowed: ["read_write"],
        source: "default",
      },
      codemode: { enabled: false, timeoutMs: 300000 },
      mcp: { servers: {} },
      sessions: { retentionDays: 0 },
      audit: { enabled: false, facility: "local0" },
      modelsFile: "/etc/pi-sandbox/models.json",
      filesystem: { cwdWritable: true, deniedPaths: [], hiddenPaths: [] },
      execution: { backend },
      identity: { mode: "disabled" },
      network: { mode: backend === "direct" ? "host" : "none" },
      environment: { pi: {}, sandbox: {}, extensions: {} },
      extensions: {},
      tools,
    },
    cwd: "/work/project",
    sandboxEnvironment: { PROJECT_MODE: "managed", RIPGREP_CONFIG_PATH: "/etc/rg" },
    ambientEnvironment: {
      PATH: "/home/alice/bin:/usr/bin",
      HOME: "/home/alice",
      PROJECT_MODE: "ambient",
      PI_SANDBOX_INTERNAL: "secret",
      UNSET: undefined,
    },
    ...(bundled ? { toolBundle } : {}),
  };
}

function analyzer(version = 1): BashCommandAnalyzer {
  return {
    version,
    commands: [],
    analyze: () => Promise.resolve({ commandClass: "known_read_only", version, commands: [] }),
  };
}

describe("Bash execution context", () => {
  it("uses the fixed Bubblewrap environment, tool-bundle PATH and administrator values", () => {
    const context = bashExecutionContext(runtime("bubblewrap"));
    expect(context).toEqual({
      backend: "bubblewrap",
      cwd: "/work/project",
      environment: {
        ...safeSandboxEnvironment(),
        PATH: `/opt/pi-sandbox/tools/bin:${safeSandboxEnvironment().PATH}`,
        PROJECT_MODE: "managed",
        RIPGREP_CONFIG_PATH: "/etc/rg",
      },
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.environment)).toBe(true);
    expect(context.environment).not.toHaveProperty("PI_SANDBOX_INTERNAL");
  });

  it("uses the fixed Seatbelt values without ambient inheritance", () => {
    expect(bashExecutionContext(runtime("seatbelt"))).toEqual({
      backend: "seatbelt",
      cwd: "/work/project",
      environment: {
        PROJECT_MODE: "managed",
        RIPGREP_CONFIG_PATH: "/etc/rg",
        PATH: "/opt/pi-sandbox/tools/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        LANG: "C.UTF-8",
      },
    });
  });

  it("uses the sanitized ambient direct environment with administrator values", () => {
    expect(bashExecutionContext(runtime("direct"))).toEqual({
      backend: "direct",
      cwd: "/work/project",
      environment: {
        PATH: "/opt/pi-sandbox/tools/bin:/home/alice/bin:/usr/bin",
        HOME: "/home/alice",
        PROJECT_MODE: "managed",
        RIPGREP_CONFIG_PATH: "/etc/rg",
      },
    });
    expect(bashExecutionContext(runtime("direct", true, false)).environment.PATH).toBe(
      "/home/alice/bin:/usr/bin",
    );
  });

  it("rejects administrator values that the executor would reject", () => {
    expect(() =>
      bashExecutionContext({ ...runtime("bubblewrap"), sandboxEnvironment: { BASH_ENV: "/x" } }),
    ).toThrow("sandbox_environment_invalid");
    expect(() =>
      bashExecutionContext({ ...runtime("seatbelt"), sandboxEnvironment: { PATH: "/x" } }),
    ).toThrow("sandbox_environment_invalid");
  });
});

describe("configured Bash analyzer", () => {
  it("is constructed only when the effective Bash policy has a class policy", () => {
    const create = vi.fn(() => analyzer());
    expect(createConfiguredBashAnalyzer(runtime("bubblewrap", false), create)).toBeUndefined();
    expect(create).not.toHaveBeenCalled();
    const created = createConfiguredBashAnalyzer(runtime("direct"), create);
    expect(created?.version).toBe(1);
    expect(create).toHaveBeenCalledWith(bashExecutionContext(runtime("direct")));
  });

  it("fails startup when construction fails or the analyzer is invalid", () => {
    expect(() =>
      createConfiguredBashAnalyzer(runtime("bubblewrap"), () => {
        throw new Error("registry unavailable");
      }),
    ).toThrow("Bash command analysis could not be initialized: registry unavailable");
    for (const version of [0, 1.5, Number.NaN, 0x1_0000_0000]) {
      expect(() =>
        createConfiguredBashAnalyzer(runtime("bubblewrap"), () => analyzer(version)),
      ).toThrow("invalid analyzer");
    }
  });
});
