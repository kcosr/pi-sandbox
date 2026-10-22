import { readFileSync } from "node:fs";
import { parse, stringify, type JsonMap } from "@iarna/toml";
import { describe, expect, it } from "vitest";
import { TOOL_NAMES, type WorkspaceToolPolicy } from "../domain/index.js";
import { gitCloneExtension } from "../managed-extensions/git-clone/index.js";
import { createManagedExtensionCatalog } from "../managed-extensions/catalog.js";
import { applyIdentityOverrides } from "../identity/client.js";
import { parseConfig } from "./parse.js";
import { projectWorkspaceMode } from "./workspace-mode.js";

const catalog = createManagedExtensionCatalog([]);
const source = readFileSync("config/default/config.toml", "utf8");
const fixture = () =>
  parse(source) as {
    [key: string]: unknown;
    filesystem: Record<string, unknown>;
    tools: Record<string, Record<string, unknown>>;
  };
function configured(change: (value: ReturnType<typeof fixture>) => void = () => {}) {
  const value = fixture();
  change(value);
  return parseConfig(stringify(value as JsonMap), "workspace fixture", catalog);
}
const allow = { mode: "allow", session_grant: "never" };
const ask = { mode: "ask", session_grant: "offer" };

function selectable(value: ReturnType<typeof fixture>) {
  value.filesystem.cwd_default = "read_only";
  value.filesystem.cwd_allowed = ["read_only", "read_write"];
  for (const name of ["bash", "write", "edit"]) {
    value.tools[name]!.read_only = allow;
    value.tools[name]!.read_write = ask;
  }
}

describe("workspace-mode administrative contract", () => {
  it("validates the documented complete example and its read-only-default policy variant", () => {
    const docs = readFileSync("docs/configuration.md", "utf8");
    const snippets = [...docs.matchAll(/```toml\n([\s\S]*?)```/gu)].map((match) => match[1]!);
    for (const snippet of snippets) expect(() => parse(snippet)).not.toThrow();
    const complete = snippets.find((snippet) => snippet.startsWith("config_version = "))!;
    const gitCatalog = createManagedExtensionCatalog([
      {
        manifest: {
          kind: "managed",
          apiVersion: 3,
          id: "git",
          version: "1.2.0",
          toolNames: ["git_clone"],
          digests: { manifestSha256: "0".repeat(64), moduleSha256: "0".repeat(64) },
        },
        extension: gitCloneExtension,
      },
    ]);
    expect(
      projectWorkspaceMode(parseConfig(complete, "documented configuration", gitCatalog)).tools
        .git_clone,
    ).toEqual({ mode: "ask", sessionGrant: "never", audit: true });
    const defaults = parse(complete);
    const filesystem = snippets.find((snippet) =>
      snippet.startsWith('[filesystem]\ncwd_default = "read_only"'),
    )!;
    const policies = snippets.find(
      (snippet) => snippet.startsWith("[tools.bash]") && snippet.includes("[tools.write]"),
    )!;
    const overlay = parse(policies) as { tools: Record<string, JsonMap> };
    const variant = stringify({
      ...defaults,
      filesystem: parse(filesystem).filesystem!,
      tools: { ...(defaults.tools as JsonMap), ...overlay.tools },
    });
    const admitted = parseConfig(variant, "documented opt-in configuration", gitCatalog);
    expect(projectWorkspaceMode(admitted).tools.bash?.mode).toBe("allow");
    expect(projectWorkspaceMode(admitted, "read_write").tools.bash?.mode).toBe("ask");
    expect(projectWorkspaceMode(admitted).tools.git_clone?.mode).toBe("ask");
  });

  it("selects filesystem authority and all seven approval branches atomically", () => {
    const administrative = configured(selectable);
    const readonly = projectWorkspaceMode(administrative);
    expect(readonly.workspace).toEqual({
      mode: "read_only",
      default: "read_only",
      allowed: ["read_only", "read_write"],
      source: "default",
    });
    expect(readonly.filesystem.cwdWritable).toBe(false);
    const writable = projectWorkspaceMode(administrative, "read_write");
    expect(writable.workspace).toEqual({
      ...readonly.workspace,
      mode: "read_write",
      source: "flag",
    });
    expect(writable.filesystem.cwdWritable).toBe(true);
    for (const name of ["bash", "write", "edit"]) {
      expect(readonly.tools[name]).toMatchObject({ mode: "allow", sessionGrant: "never" });
      expect(writable.tools[name]).toMatchObject({ mode: "ask", sessionGrant: "offer" });
    }
    for (const name of TOOL_NAMES)
      expect(writable.tools[name]?.audit).toBe(administrative.tools[name]?.audit);
    expect(projectWorkspaceMode(administrative, "read_only").workspace.source).toBe("flag");
    for (const value of [
      readonly,
      readonly.workspace,
      readonly.workspace.allowed,
      readonly.tools,
      readonly.tools.bash,
    ])
      expect(Object.isFrozen(value)).toBe(true);
  });

  it("rejects prohibited requests and uses final identity defaults and allowed modes", () => {
    const base = configured();
    expect(() => projectWorkspaceMode(base, "read_only")).toThrow("not permitted");
    const effective = applyIdentityOverrides(base, {
      filesystem: { cwdDefault: "read_only", cwdAllowed: ["read_only"] },
      tools: { bash: { readOnly: { mode: "allow", sessionGrant: "never" } } },
    });
    const runtime = projectWorkspaceMode(effective);
    expect(runtime.workspace.mode).toBe("read_only");
    expect(runtime.tools.bash?.mode).toBe("allow");
    expect(() => projectWorkspaceMode(effective, "read_write")).toThrow("not permitted");
    expect(projectWorkspaceMode(base).workspace.mode).toBe("read_write");
  });

  it("does not relax host Git or MCP when projecting a read-only workspace", () => {
    const base = configured(selectable);
    const host = Object.freeze({ mode: "ask", sessionGrant: "never", audit: true } as const);
    const withHost = { ...base, tools: { ...base.tools, git_clone: host } };
    const runtime = projectWorkspaceMode(withHost);
    expect(runtime.tools.git_clone).toBe(host);
    expect(runtime.mcp).toBe(base.mcp);
    expect(runtime.network).toBe(base.network);
  });

  it("disabled tools project classless policies and branch overrides cannot enable them", () => {
    const base = configured((value) => {
      selectable(value);
      value.tools.bash!.enabled = false;
      value.tools.bash!.read_write = { ...ask, known_read_only: allow };
    });
    const edited = applyIdentityOverrides(base, {
      tools: { bash: { readOnly: { mode: "allow", sessionGrant: "never" } } },
    });
    for (const mode of ["read_only", "read_write"] as const) {
      expect(projectWorkspaceMode(edited, mode).tools.bash).toEqual({
        mode: "disabled",
        sessionGrant: "never",
        audit: true,
      });
    }
    expect((edited.tools.bash as WorkspaceToolPolicy).enabled).toBe(false);
  });

  it("validates the unselected branch and prerequisite availability even when Bash is disabled", () => {
    for (const disabled of [true, false]) {
      expect(() =>
        configured((value) => {
          value.tools.bash!.enabled = !disabled;
          value.tools.bash!.read_only = { ...ask, known_read_only: allow };
          value.tools.read!.enabled = false;
        }),
      ).toThrow("requires");
      expect(() =>
        configured((value) => {
          value.tools.bash!.enabled = !disabled;
          value.tools.bash!.read_only = { ...allow, known_read_only: allow };
        }),
      ).toThrow("strictly more permissive");
    }
  });

  it("rejects old, incomplete, duplicate, contradictory and cross-kind authored shapes", () => {
    const changes: Array<(value: ReturnType<typeof fixture>) => void> = [
      (value) => {
        value.config_version = 13;
      },
      (value) => {
        value.filesystem.cwd_writable = true;
      },
      (value) => {
        delete value.filesystem.cwd_default;
      },
      (value) => {
        delete value.filesystem.cwd_allowed;
      },
      (value) => {
        value.filesystem.cwd_allowed = [];
      },
      (value) => {
        value.filesystem.cwd_allowed = ["read_write", "read_write"];
      },
      (value) => {
        value.filesystem.cwd_allowed = ["read_only"];
      },
      (value) => {
        value.filesystem.cwd_default = "readonly";
      },
      (value) => {
        value.filesystem.cwd_allowed = ["read_write", "disabled"];
      },
      (value) => {
        value.tools.bash = { ...allow, audit: true };
      },
      (value) => {
        delete value.tools.bash!.enabled;
      },
      (value) => {
        value.tools.bash!.enabled = "true";
      },
      (value) => {
        delete value.tools.bash!.read_only;
      },
      (value) => {
        delete value.tools.bash!.read_write;
      },
      (value) => {
        value.tools.bash!.read_only = { mode: "disabled", session_grant: "never" };
      },
      (value) => {
        value.tools.bash!.read_only = { mode: "ask" };
      },
      (value) => {
        value.tools.bash!.read_only = { ...allow, audit: false };
      },
      (value) => {
        value.tools.bash!.read_only = { ...allow, session_grant: "offer" };
      },
      (value) => {
        value.tools.read!.read_only = { ...ask, known_read_only: allow };
      },
      (value) => {
        value.tools.bash!.known_read_only = allow;
      },
    ];
    for (const change of changes) expect(() => configured(change)).toThrow();
  });

  it("rejects direct execution if any read-only mode is admitted", () => {
    const directSource = readFileSync("config/default/config.direct.toml", "utf8");
    const direct = parseConfig(directSource, "direct", catalog);
    expect(projectWorkspaceMode(direct).filesystem.cwdWritable).toBe(true);
    expect(projectWorkspaceMode(direct).tools.bash?.mode).toBe("disabled");
    expect(() =>
      parseConfig(
        directSource.replace(
          'cwd_allowed = ["read_write"]',
          'cwd_allowed = ["read_only", "read_write"]',
        ),
        "direct",
        catalog,
      ),
    ).toThrow("cwd_allowed");
    expect(() => projectWorkspaceMode(direct, "read_only")).toThrow("not permitted");
  });
});
