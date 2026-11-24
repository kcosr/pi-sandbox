import { readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { parse as parseToml, stringify } from "@iarna/toml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createManagedExtensionCatalog } from "../managed-extensions/catalog.js";
import { loadConfig } from "./load.js";
import { MAXIMUM_CONFIG_BYTES, parseConfig } from "./parse.js";
import { resolveWorkspaceAccess, resolveWorkspaceSelection } from "./workspace.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const original = await importOriginal<typeof fs>();
  return { ...original, open: vi.fn(original.open) };
});

type Table = Record<string, unknown>;
const catalog = createManagedExtensionCatalog([]);
const packaged = readFileSync(new URL("../../config/default/config.toml", import.meta.url), "utf8");
const fixture = () => parseToml(packaged) as Table;
function table(parent: Table, key: string): Table {
  const value = parent[key];
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`Missing fixture table ${key}`);
  return value as Table;
}
function modes(input: Table): Table {
  return table(table(input, "workspace"), "modes");
}
function encode(input: Table): string {
  return stringify(input as Parameters<typeof stringify>[0]);
}
function changed(change: (input: Table) => void) {
  const input = fixture();
  change(input);
  return parseConfig(encode(input), "modes.toml", catalog);
}
const invocation = (mode = "allow", session_grant = "never") => ({ mode, session_grant });
const commandSet = () => ({
  command: "utility",
  mode: "allow",
  session_grant: "never",
  operands: { min: 0, max: 0 },
});

afterEach(() => vi.restoreAllMocks());

describe("workspace mode composition", () => {
  it.each([
    {
      file: "config.toml",
      backend: "bubblewrap",
      network: "none",
      allowed: ["host", "sandbox"],
      modes: [
        { name: "host", cwdWritable: true, exports: false, bash: "ask", write: "ask", edit: "ask" },
        {
          name: "sandbox",
          cwdWritable: false,
          exports: true,
          bash: "allow",
          write: "allow",
          edit: "allow",
        },
      ],
    },
    {
      file: "config.seatbelt.toml",
      backend: "seatbelt",
      network: "none",
      allowed: ["host", "sandbox"],
      modes: [
        {
          name: "host",
          cwdWritable: true,
          exports: false,
          bash: "disabled",
          write: "ask",
          edit: "ask",
        },
        {
          name: "sandbox",
          cwdWritable: false,
          exports: true,
          bash: "disabled",
          write: "allow",
          edit: "allow",
        },
      ],
    },
    {
      file: "config.direct.toml",
      backend: "direct",
      network: "host",
      allowed: ["host"],
      modes: [
        {
          name: "host",
          cwdWritable: true,
          exports: false,
          bash: "disabled",
          write: "ask",
          edit: "ask",
        },
      ],
    },
  ])("preserves the prior host policy and resolves every mode in $file", (expected) => {
    const source = readFileSync(
      new URL(`../../config/default/${expected.file}`, import.meta.url),
      "utf8",
    );
    const authored = parseConfig(source, expected.file, catalog);
    expect(authored.workspace.default).toBe("host");
    expect(authored.workspace.allowed).toEqual(expected.allowed);
    expect(Object.keys(authored.workspace.modes).sort()).toEqual(expected.allowed);
    const defaultHost = resolveWorkspaceSelection(authored);
    expect(defaultHost.selection).toMatchObject({ name: "host", source: "default" });
    for (const mode of expected.modes) {
      const selected =
        mode.name === "host"
          ? defaultHost
          : resolveWorkspaceSelection(authored, undefined, mode.name);
      const config = selected.config;
      expect(selected.selection).toMatchObject({
        name: mode.name,
        source: mode.name === "host" ? "default" : "cli",
      });
      expect(config.execution.backend).toBe(expected.backend);
      expect(config.network).toEqual({ mode: expected.network });
      expect(config.filesystem).toEqual({
        cwdWritable: mode.cwdWritable,
        hiddenPaths: [],
        deniedPaths: [],
      });
      expect(config.exports).toEqual({ enabled: mode.exports });
      expect(config.audit).toEqual({ enabled: false, facility: "local0" });
      // These explicit prior/default expectations also detect missing audit-map integration,
      // session offers or inherited Bash exceptions in any packaged mode.
      expect(config.tools).toEqual({
        read: { mode: "allow", sessionGrant: "never", audit: false },
        grep: { mode: "allow", sessionGrant: "never", audit: false },
        find: { mode: "allow", sessionGrant: "never", audit: false },
        ls: { mode: "allow", sessionGrant: "never", audit: false },
        bash: { mode: mode.bash, sessionGrant: "never", audit: true },
        write: { mode: mode.write, sessionGrant: "never", audit: true },
        edit: { mode: mode.edit, sessionGrant: "never", audit: true },
      });
      expect(Object.isFrozen(selected.selection)).toBe(true);
    }
    expect(Object.isFrozen(authored.workspace.modes)).toBe(true);
  });

  it("permits omitted common leaves only when every mode completes them", () => {
    const authored = changed((input) => {
      delete table(input, "filesystem").cwd_writable;
      delete input.exports;
      for (const tool of ["bash", "write", "edit"]) delete table(input, "tools")[tool];
      Object.assign(table(modes(input), "host"), {
        filesystem: { cwd_writable: true },
        exports: { enabled: false },
        tools: { bash: invocation("ask"), write: invocation("ask"), edit: invocation("ask") },
      });
    });
    expect(resolveWorkspaceSelection(authored).config.tools.write!.mode).toBe("ask");
    expect(() =>
      changed((input) => {
        delete table(input, "tools").bash;
        table(input, "workspace").allowed = ["sandbox"];
        table(input, "workspace").default = "sandbox";
      }),
    ).toThrow('workspace mode "host": config.tools.bash is required');
  });

  it("validates supplied common entries even if all modes replace them", () => {
    expect(() =>
      changed((input) => {
        table(input, "tools").bash = invocation("allow", "offer");
        table(modes(input), "host").tools = { bash: invocation() };
      }),
    ).toThrow('config.tools.bash.session_grant may be "offer" only when mode is "ask"');
    expect(() =>
      changed((input) => {
        table(table(input, "tools"), "bash").audit = true;
      }),
    ).toThrow("config.tools.bash.audit is not a recognized field");
  });

  it("checks effective relationships after composition rather than requiring launchable common defaults", () => {
    const authored = changed((input) => {
      table(input, "exports").enabled = true;
      table(modes(input), "host").filesystem = { cwd_writable: false };
    });
    expect(resolveWorkspaceSelection(authored).config.exports.enabled).toBe(true);
    const noCommonClass = changed((input) => {
      table(input, "tools").read = invocation("deny");
      table(input, "tools").bash = { ...invocation("deny"), known_read_only: invocation() };
      table(modes(input), "host").tools = { bash: invocation() };
    });
    expect(
      resolveWorkspaceSelection(noCommonClass).config.tools.bash!.commandClasses,
    ).toBeUndefined();
    expect(() =>
      changed((input) => {
        table(modes(input), "host").exports = { enabled: true };
      }),
    ).toThrow('workspace mode "host": config.workspace.modes.host.exports.enabled requires');
  });

  it("replaces complete invocation entries without retaining common classes, grants or command sets", () => {
    const authored = changed((input) => {
      table(input, "tools").bash = {
        ...invocation("ask", "offer"),
        known_read_only: invocation(),
        command_sets: { utility: commandSet() },
      };
    });
    expect(resolveWorkspaceSelection(authored).config.tools.bash).toMatchObject({
      sessionGrant: "offer",
      commandClasses: { known_read_only: { mode: "allow" } },
    });
    const sandbox = resolveWorkspaceSelection(authored, undefined, "sandbox").config.tools.bash!;
    expect(sandbox.sessionGrant).toBe("never");
    expect(sandbox.commandClasses).toBeUndefined();
    expect(sandbox.commandSets).toBeUndefined();
  });

  it("attributes conflicting CWD and export values to their common or mode origins", () => {
    expect(() =>
      changed((input) => {
        table(input, "filesystem").cwd_writable = false;
        table(input, "exports").enabled = true;
        table(modes(input), "host").filesystem = { cwd_writable: true };
      }),
    ).toThrow(
      'workspace mode "host": config.exports.enabled requires a confined backend and config.workspace.modes.host.filesystem.cwd_writable = false',
    );
    expect(() =>
      changed((input) => {
        table(modes(input), "host").exports = { enabled: true };
      }),
    ).toThrow(
      'workspace mode "host": config.workspace.modes.host.exports.enabled requires a confined backend and config.filesystem.cwd_writable = false',
    );
  });

  it("normalizes equivalent command sets but rejects conflicting IDs in unused entries", () => {
    const authored = changed((input) => {
      table(table(input, "tools"), "bash").command_sets = { utility: commandSet() };
      table(table(table(modes(input), "sandbox"), "tools"), "bash").command_sets = {
        utility: {
          ...commandSet(),
          command: ["utility"],
          required_flags: [],
          optional_flags: [],
          options: {},
        },
      };
    });
    expect(
      resolveWorkspaceSelection(authored, undefined, "sandbox").config.tools.bash!.commandSets,
    ).toHaveProperty("utility");
    expect(() =>
      changed((input) => {
        table(table(input, "tools"), "bash").command_sets = { utility: commandSet() };
        table(modes(input), "host").tools = { bash: invocation() };
        table(input, "workspace").allowed = ["host"];
        table(table(table(modes(input), "sandbox"), "tools"), "bash").command_sets = {
          utility: { ...commandSet(), operands: { min: 0, max: 1 } },
        };
      }),
    ).toThrow(
      "config.workspace.modes.sandbox.tools.bash.command_sets.utility conflicts with the command-set definition at config.tools.bash.command_sets.utility",
    );
  });

  it("compares set-valued command alternatives, flags, option keys and exact values without order", () => {
    expect(() =>
      changed((input) => {
        const rule = {
          ...commandSet(),
          command: ["utility", "/opt/utility"],
          required_flags: ["--read", "--quiet"],
          optional_flags: ["--json", "--verbose"],
          options: { "--style": ["json", "text"], "--file": { any_literal: true } },
        };
        table(table(input, "tools"), "bash").command_sets = { utility: rule };
        table(table(table(modes(input), "sandbox"), "tools"), "bash").command_sets = {
          utility: {
            ...rule,
            command: [...rule.command].reverse(),
            required_flags: [...rule.required_flags].reverse(),
            optional_flags: [...rule.optional_flags].reverse(),
            options: { "--file": { any_literal: true }, "--style": ["text", "json"] },
          },
        };
      }),
    ).not.toThrow();
  });

  it("requires exact audit coverage even for disabled tools with global logging disabled", () => {
    expect(() =>
      changed((input) => {
        table(input, "tools").bash = invocation("disabled");
        delete table(table(input, "audit"), "tools").bash;
      }),
    ).toThrow("config.audit.tools.bash is required");
    expect(() =>
      changed((input) => {
        table(table(input, "audit"), "tools").unknown = true;
      }),
    ).toThrow("config.audit.tools.unknown is not a recognized field");
  });

  it("distinguishes absent exports defaults from an empty authored table", () => {
    expect(() =>
      changed((input) => {
        input.exports = {};
      }),
    ).toThrow("config.exports.enabled is required");
    expect(() =>
      changed((input) => {
        delete input.exports;
        table(modes(input), "host").exports = { enabled: false };
      }),
    ).not.toThrow();
  });

  it.each([
    ["audit", { enabled: false }],
    ["execution", { backend: "direct" }],
    ["network", { mode: "host" }],
    ["filesystem", { cwd_writable: true, hidden_paths: [] }],
    ["tools", { read: invocation() }],
    ["tools", {}],
    ["exports", {}],
  ])("rejects excluded or empty mode entry %s", (key, value) => {
    expect(() =>
      changed((input) => {
        table(modes(input), "host")[key] = value;
      }),
    ).toThrow();
  });

  it.each([
    "",
    "  ",
    "x".repeat(257),
    "é".repeat(129),
    "line\nnext",
    "\u001b[0m",
    "zero\u200bwidth",
    "x\u2028y",
    1,
  ])("rejects invalid descriptions %j", (description) => {
    expect(() =>
      changed((input) => {
        table(modes(input), "host").description = description;
      }),
    ).toThrow("description must be nonblank single-line text");
  });

  it("preserves literal description text and accepts its exact UTF-8 limit", () => {
    const authored = changed((input) => {
      table(modes(input), "host").description = "  Host project  ";
      table(modes(input), "sandbox").description = "é".repeat(128);
    });
    expect(resolveWorkspaceSelection(authored).selection.description).toBe("  Host project  ");
    expect(resolveWorkspaceAccess(authored).allowed[1]!.description).toBe("é".repeat(128));
  });

  it("rejects oversized inventories and invalid or duplicate mode names", () => {
    for (const names of [
      ["host", "host"],
      ["Host"],
      ["x".repeat(33)],
      Array.from({ length: 33 }, (_, n) => `mode${n}`),
    ])
      expect(() =>
        changed((input) => {
          table(input, "workspace").allowed = names;
        }),
      ).toThrow();
    expect(() =>
      changed((input) => {
        for (let n = 0; n < 31; n++) modes(input)[`extra${n}`] = {};
      }),
    ).toThrow("1–32 mode definitions");
  });

  it("supports own mode identifiers such as constructor without inheriting prototype entries", () => {
    const authored = changed((input) => {
      Object.assign(modes(input), { constructor: {} });
      table(input, "workspace").allowed = ["constructor"];
      table(input, "workspace").default = "constructor";
    });
    expect(resolveWorkspaceSelection(authored).selection.name).toBe("constructor");
    expect(() =>
      changed((input) => {
        table(input, "workspace").default = "constructor";
        table(input, "workspace").allowed = ["constructor"];
      }),
    ).toThrow("undefined mode");
  });
});

describe("workspace access and selection", () => {
  const authored = parseConfig(packaged, "packaged", catalog);
  it("uses account grants as replacement metadata and supports granting a defined mode outside main allowed", () => {
    const restricted = changed((input) => {
      table(input, "workspace").allowed = ["host"];
    });
    expect(
      resolveWorkspaceSelection(restricted, { allowed: ["sandbox"], default: "sandbox" }).selection,
    ).toMatchObject({ name: "sandbox", source: "default" });
    expect(
      resolveWorkspaceAccess(authored, { allowed: ["sandbox", "host"] }).allowed.map((m) => m.name),
    ).toEqual(["host", "sandbox"]);
  });
  it("rejects invalid effective defaults even when the CLI requests an allowed mode", () => {
    expect(() => resolveWorkspaceSelection(authored, { allowed: ["sandbox"] }, "sandbox")).toThrow(
      'default "host" is not selectable',
    );
    expect(() => resolveWorkspaceSelection(authored, { default: "unknown" }, "host")).toThrow(
      'default is undefined: "unknown"',
    );
  });
  it("rejects empty/unknown grants and reports only selectable names in a forbidden-choice error", () => {
    expect(() => resolveWorkspaceAccess(authored, { allowed: [] })).toThrow(
      "No workspace mode is selectable",
    );
    expect(() => resolveWorkspaceAccess(authored, { allowed: ["unknown"] })).toThrow(
      "allowed list names an undefined mode",
    );
    expect(() => resolveWorkspaceSelection(authored, { allowed: ["host"] }, "sandbox")).toThrow(
      'Workspace mode "sandbox" is not selectable. Allowed modes: host',
    );
    expect(() => resolveWorkspaceSelection(authored, { allowed: ["host"] }, "unknown")).toThrow(
      "Allowed modes: host",
    );
  });
});

describe("bounded main configuration", () => {
  it("accepts the exact source limit and rejects one byte more before parsing", () => {
    const source = packaged + " ".repeat(MAXIMUM_CONFIG_BYTES - Buffer.byteLength(packaged));
    expect(parseConfig(source, "limit", catalog).workspace.default).toBe("host");
    expect(() => parseConfig(source + " ", "over", catalog)).toThrow("exceeds 1048576 bytes");
  });
  it("bounds reads even when the file grows past its initial metadata size", async () => {
    const close = vi.fn(() => Promise.resolve());
    const read = vi.fn((_buffer: Buffer, _offset: number, length: number) =>
      Promise.resolve({
        bytesRead: length,
      }),
    );
    vi.mocked(fs.open).mockResolvedValueOnce({
      stat: () => Promise.resolve({ size: 0, isFile: () => true }),
      read,
      close,
    } as unknown as FileHandle);
    await expect(loadConfig("growing.toml", catalog)).rejects.toThrow("exceeds 1048576 bytes");
    expect(read).toHaveBeenCalledOnce();
    expect(read.mock.calls[0]![2]).toBe(MAXIMUM_CONFIG_BYTES + 1);
    expect(close).toHaveBeenCalledOnce();
  });
});
