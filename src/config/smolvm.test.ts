import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseConfig } from "./parse.js";
import { createManagedExtensionCatalog } from "../managed-extensions/catalog.js";
import { applyIdentityOverrides, parseBrokerResponse } from "../identity/client.js";
import { assertExecutionPlatform } from "../runtime/main.js";

const base = await readFile(new URL("../../tests/fixtures/config.toml", import.meta.url), "utf8");
const imagePolicy = `
[smolvm]
image = "/opt/pi/images/tools.smolmachine"
image_sha256 = "${"a".repeat(64)}"
state_directory = "/var/tmp/private-pi-vms"
cpus = 2
memory_mib = 1024
storage_gib = 1
overlay_gib = 1
`;
const vm =
  base
    .replace('backend = "bubblewrap"', 'backend = "smolvm"')
    .replace('process_lifetime = "command"\n', "") + imagePolicy;
const catalog = createManagedExtensionCatalog([]);
const parse = (source: string) => parseConfig(source, "test", catalog);
const layout = { smolvm: { path: "/opt/smolvm/smolvm", version: "1.25.4" } } as const;

describe("managed smolvm policy", () => {
  it("selects a fixed VM lifetime and immutable administrator image policy", () => {
    const config = parse(vm);
    expect(config.execution).toEqual({ backend: "smolvm", processLifetime: "sandbox" });
    expect(config.smolvm).toEqual({
      image: "/opt/pi/images/tools.smolmachine",
      imageSha256: "a".repeat(64),
      stateDirectory: "/var/tmp/private-pi-vms",
      cpus: 2,
      memoryMiB: 1024,
      storageGiB: 1,
      overlayGiB: 1,
    });
    expect(Object.isFrozen(config.smolvm)).toBe(true);
    expect(() => assertExecutionPlatform(config, "linux", layout)).not.toThrow();
    // Build/config validation does not need installed runtime/image paths or KVM.
    expect(() => assertExecutionPlatform(config, "linux", {})).toThrow("smolvm execution provider");
    expect(() => assertExecutionPlatform(config, "darwin", layout)).toThrow("only on Linux");
  });

  it("retains an optional image policy for a later broker backend selection", () => {
    const config = parse(base + imagePolicy);
    const selected = applyIdentityOverrides(config, {
      execution: { backend: "smolvm" },
      tools: {},
    });
    expect(selected.smolvm).toBe(config.smolvm);
    expect(selected.execution).toEqual({ backend: "smolvm", processLifetime: "sandbox" });
    expect(() => assertExecutionPlatform(selected, "linux", layout)).not.toThrow();
    const returned = applyIdentityOverrides(selected, {
      execution: { backend: "bubblewrap" },
      tools: {},
    });
    expect(returned.execution).toEqual({ backend: "bubblewrap", processLifetime: "command" });
    expect(
      applyIdentityOverrides(selected, {
        execution: { backend: "direct" },
        network: { mode: "host" },
        tools: {},
      }).execution,
    ).toEqual({ backend: "direct", processLifetime: "command" });
    expect(
      applyIdentityOverrides(selected, {
        execution: { backend: "bubblewrap", processLifetime: "sandbox" },
        tools: {},
      }).execution.processLifetime,
    ).toBe("sandbox");
    expect(() =>
      applyIdentityOverrides(selected, { execution: { processLifetime: "sandbox" }, tools: {} }),
    ).toThrow("does not support");
  });

  it("validates state-directory account templates without expanding installation paths", () => {
    const source = vm.replace("/var/tmp/private-pi-vms", "/var/tmp/pi-vm-{{uid}}");
    expect(parse(source).smolvm?.stateDirectory).toBe("/var/tmp/pi-vm-{{uid}}");
    expect(() => parse(source.replace("{{uid}}", "{{HOME}}"))).toThrow("account macro syntax");
    expect(() => parse(source.replace("{{uid}}", "{{uid}"))).toThrow("account macro syntax");
    expect(() => parse(source.replace("/var/tmp/pi-vm-{{uid}}", "~/pi-vm"))).toThrow(
      "normalized absolute path",
    );
    const fixedImage = source.replace("/opt/pi/images", "/opt/{{uid}}/images");
    expect(parse(fixedImage).smolvm?.image).toBe("/opt/{{uid}}/images/tools.smolmachine");
  });

  it("revalidates broker combinations without enabling implicit fallback", () => {
    const selected = applyIdentityOverrides(parse(base), {
      execution: { backend: "smolvm" },
      tools: {},
    });
    expect(() => assertExecutionPlatform(selected, "linux", layout)).toThrow("configured image");
    const config = parse(vm);
    expect(() =>
      assertExecutionPlatform(
        applyIdentityOverrides(config, { network: { mode: "host" }, tools: {} }),
        "linux",
        layout,
      ),
    ).toThrow("network.mode = none");
    const response = (overrides: unknown) =>
      JSON.stringify({
        version: 6,
        status: "ok",
        environment: { pi: {}, sandbox: {}, extensions: {} },
        overrides,
      });
    expect(parseBrokerResponse(response({ execution: { backend: "smolvm" } }))).toMatchObject({
      overrides: { execution: { backend: "smolvm" } },
    });
    expect(() => parseBrokerResponse(response({ smolvm: { image: "/tmp/other" } }))).toThrow();
    expect(() =>
      parseBrokerResponse(
        response({ execution: { backend: "smolvm", process_lifetime: "sandbox" } }),
      ),
    ).toThrow();
  });

  it("enforces the literal state-directory byte limit before runtime startup", () => {
    const withState = (value: string) => vm.replace("/var/tmp/private-pi-vms", value);
    expect(parse(withState("/" + "a".repeat(47))).smolvm?.stateDirectory).toHaveLength(48);
    expect(() => parse(withState("/" + "a".repeat(48)))).toThrow("at most 48 bytes");
    expect(() => parse(withState("/" + "é".repeat(24)))).toThrow("at most 48 bytes");
    // Account templates retain their separate post-expansion validation.
    const template = "/" + "a".repeat(42) + "{{uid}}";
    expect(parse(withState(template)).smolvm?.stateDirectory).toBe(template);
  });

  it.each([
    ['backend = "smolvm"', 'backend = "smolvm"\nprocess_lifetime = "sandbox"', "process_lifetime"],
    ['mode = "none"', 'mode = "host"', "network.mode"],
    ['mode = "none"', 'mode = "local"', "network.mode"],
    ["hidden_paths = []", 'hidden_paths = ["/srv/private"]', "hidden_paths"],
    ['image = "/opt/pi/images/tools.smolmachine"', 'image = "./tools.smolmachine"', "smolvm.image"],
    ['state_directory = "/var/tmp/private-pi-vms"', 'state_directory = "/"', "state_directory"],
    ["cpus = 2", "cpus = 33", "cpus"],
    ["cpus = 2", "cpus = 1.5", "cpus"],
    ["memory_mib = 1024", "memory_mib = 128", "memory_mib"],
    ["storage_gib = 1", "storage_gib = 65", "storage_gib"],
    ["overlay_gib = 1", "overlay_gib = 0", "overlay_gib"],
    ['image_sha256 = "' + "a".repeat(64) + '"', 'image_sha256 = "bad"', "image_sha256"],
    ["cpus = 2", 'cpus = 2\nexecutable = "/tmp/smolvm"', "not a recognized field"],
    ["cpus = 2\n", "", "cpus is required"],
  ])("rejects invalid backend authority %#", (from, to, error) => {
    expect(() => parse(vm.replace(from, to))).toThrow(error);
  });

  it("requires the image block and current schema", () => {
    expect(() => parse(vm.replace(imagePolicy, ""))).toThrow("config.smolvm is required");
    expect(() => parse(vm.replace("config_version = 11", "config_version = 10"))).toThrow(
      "integer 11",
    );
  });
});
