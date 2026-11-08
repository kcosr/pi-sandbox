import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { createManagedExtensionCatalog } from "../managed-extensions/catalog.js";
import gitCloneExtension from "../managed-extensions/git-clone/index.js";
import { parseConfig } from "./parse.js";
import { applyIdentityOverrides, parseBrokerResponse } from "../identity/client.js";
import type { SandboxConfig } from "../domain/index.js";

const catalog = createManagedExtensionCatalog([
  {
    manifest: {
      kind: "managed",
      apiVersion: 3,
      id: "git",
      version: gitCloneExtension.version,
      toolNames: ["git_clone"],
      digests: { manifestSha256: "a".repeat(64), moduleSha256: "b".repeat(64) },
    },
    extension: gitCloneExtension,
  },
]);
const base = await readFile(new URL("../../config/default/config.toml", import.meta.url), "utf8");
function source(destination?: string): string {
  return (
    base +
    `\n[extensions.git]\nallowed_hosts = ["example.invalid"]\nallowed_schemes = ["https", "ssh"]\n${destination === undefined ? "" : `destination = "${destination}"\n`}\n[tools.git_clone]\nmode = "ask"\nsession_grant = "never"\naudit = true\n`
  );
}
function resolved(destination?: string): SandboxConfig {
  return parseConfig(source(destination), "test", catalog) as SandboxConfig;
}

describe("Git clone deployment destination", () => {
  it("preserves omitted and explicit host mode with a read-only CWD", () => {
    for (const destination of [undefined, "host_cwd"]) {
      const config = parseConfig(
        source(destination).replace("cwd_writable = true", "cwd_writable = false"),
        "test",
        catalog,
      );
      expect(config.extensions.git?.settings.destination).toBe("host_cwd");
    }
  });
  it("admits scratch cloning with either CWD access mode on Bubblewrap", () => {
    for (const writable of [true, false])
      expect(
        parseConfig(
          source("sandbox_home").replace("cwd_writable = true", `cwd_writable = ${writable}`),
          "test",
          catalog,
        ).extensions.git?.settings.destination,
      ).toBe("sandbox_home");
  });
  it.each(["direct", "seatbelt"])("rejects sandbox_home with %s before startup", (backend) => {
    expect(() =>
      parseConfig(
        source("sandbox_home")
          .replace('backend = "bubblewrap"', `backend = "${backend}"`)
          .replace('[network]\nmode = "none"', '[network]\nmode = "host"'),
        "test",
        catalog,
      ),
    ).toThrow("requires Bubblewrap");
  });
  it("rechecks broker backend changes and preserves the main destination", () => {
    const config = resolved("sandbox_home");
    expect(applyIdentityOverrides(config, { tools: {} }).extensions).toBe(config.extensions);
    expect(() =>
      applyIdentityOverrides(config, {
        execution: { backend: "direct" },
        network: { mode: "host" },
        tools: {},
      }),
    ).toThrow("requires Bubblewrap");
    const host = resolved();
    expect(
      applyIdentityOverrides(host, { filesystem: { cwdWritable: false }, tools: {} }).extensions,
    ).toBe(host.extensions);
  });
  it("rejects broker attempts to replace the destination", () => {
    expect(() =>
      parseBrokerResponse(
        JSON.stringify({
          version: 10,
          status: "ok",
          environment: { pi: {}, sandbox: {}, extensions: {} },
          overrides: { extensions: { git: { destination: "host_cwd" } } },
        }),
      ),
    ).toThrow();
  });
});
