#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";

import { createCompiledLayoutModule, loadDistribution } from "../build/distribution.mjs";
import { renderLayoutText } from "../build/layout-render.mjs";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-sandbox-distribution-test-"));
try {
  const path = join(temporaryDirectory, "distribution.toml");
  await writeFile(
    path,
    `version = 3
allow_config_override = false
extension_manifests = ["./extension.json"]

[platforms.linux]
config_dir = "/opt/example/etc"
libexec_dir = "/opt/example/libexec"
launcher_path = "/opt/example/bin/pi-sandbox"
service_dir = "/opt/example/systemd"
identity_socket_path = "/opt/example/run/broker.sock"
audit_socket_path = "/opt/example/run/collector.sock"

[platforms.linux.bubblewrap]
mode = "system"
path = "/opt/example/bin/bwrap"
`,
  );
  const validManifest = await readFile(path, "utf8");
  await writeFile(path, validManifest.replace("version = 3", "version = 1"));
  await assert.rejects(loadDistribution(path, "linux"), /version must be 3/);
  await writeFile(path, validManifest.replace("version = 3", "version = 2"));
  await assert.rejects(loadDistribution(path, "linux"), /version must be 3/);
  for (const declaration of ["", 'allow_config_override = "true"']) {
    await writeFile(path, validManifest.replace("allow_config_override = false", declaration));
    await assert.rejects(
      loadDistribution(path, "linux"),
      /allow_config_override must be a boolean/,
    );
  }
  await writeFile(
    path,
    validManifest.replace("allow_config_override = false", "allow_config_override = true"),
  );
  const configurable = await loadDistribution(path, "linux");
  assert.equal(configurable.layout.allowConfigOverride, true);
  assert.match(createCompiledLayoutModule(configurable.layout), /"allowConfigOverride":true/);
  await writeFile(
    path,
    validManifest.replace('audit_socket_path = "/opt/example/run/collector.sock"', ""),
  );
  await assert.rejects(loadDistribution(path, "linux"), /audit_socket_path/);
  await writeFile(
    path,
    validManifest.replace("/opt/example/run/collector.sock", "/opt/example/run/broker.sock"),
  );
  await assert.rejects(loadDistribution(path, "linux"), /must differ/);
  await writeFile(path, validManifest);
  const distribution = await loadDistribution(path, "linux");
  assert.deepEqual(distribution.layout, {
    allowConfigOverride: false,
    configDir: "/opt/example/etc",
    configPath: "/opt/example/etc/config.toml",
    defaultModelsPath: "/opt/example/etc/models.json",
    libexecDir: "/opt/example/libexec",
    launcherPath: "/opt/example/bin/pi-sandbox",
    identitySocketPath: "/opt/example/run/broker.sock",
    auditSocketPath: "/opt/example/run/collector.sock",
    serviceDir: "/opt/example/systemd",
    bubblewrap: { mode: "system", path: "/opt/example/bin/bwrap" },
  });
  assert.deepEqual(distribution.bubblewrap.release, {
    mode: "system",
    path: "/opt/example/bin/bwrap",
  });
  assert.match(createCompiledLayoutModule(distribution.layout), /opt\/example\/etc/);
  const rendered = renderLayoutText(
    `launcher=/usr/bin/pi-sandbox
base=/usr/libexec/pi-sandbox
config=/etc/pi-sandbox
service=/usr/lib/systemd/system
socket=/run/pi-sandbox-identity/broker.sock
audit=/run/pi-sandbox-audit/collector.sock
audit_unit=../../../libexec/pi-sandbox/systemd/pi-sandbox-audit.socket
link=../libexec/pi-sandbox/pi-sandbox
unit=../../../libexec/pi-sandbox/systemd/pi-sandbox-identity-broker.socket
`,
    distribution.layout,
    "linux",
  );
  assert.match(rendered, /audit=\/opt\/example\/run\/collector\.sock/);
  assert.match(rendered, /audit_unit=\.\.\/libexec\/systemd\/pi-sandbox-audit\.socket/);
  assert.match(rendered, /launcher=\/opt\/example\/bin\/pi-sandbox/);
  assert.match(rendered, /link=\.\.\/libexec\/pi-sandbox/);
  assert.match(rendered, /unit=\.\.\/libexec\/systemd\/pi-sandbox-identity-broker\.socket/);
  assert.doesNotMatch(rendered, /\/etc\/pi-sandbox|\/usr\/libexec\/pi-sandbox/);
  const installer = renderLayoutText(
    await readFile(new URL("../install/install.sh", import.meta.url), "utf8"),
    distribution.layout,
    "linux",
  );
  assert.match(installer, /install_base="\$\{root_prefix\}\/opt\/example\/libexec"/);
  assert.match(installer, /launcher="\$\{root_prefix\}\/opt\/example\/bin\/pi-sandbox"/);
  assert.doesNotMatch(installer, /root_prefix\}\/etc\/pi-sandbox/);
  assert.match(installer, /bubblewrap_runtime="\/opt\/example\/bin\/bwrap"/);

  await writeFile(
    path,
    `version = 3
allow_config_override = false
extension_manifests = []

[platforms.linux]
config_dir = "/etc/pi-sandbox"
libexec_dir = "/opt/pi-sandbox"
launcher_path = "/usr/bin/pi-sandbox"
service_dir = "/usr/lib/systemd/system"
identity_socket_path = "/run/pi-sandbox-identity/broker.sock"
audit_socket_path = "/run/pi-sandbox-audit/collector.sock"

[platforms.linux.bubblewrap]
mode = "bundled"
binary = "./bwrap"
version = "0.11.2"
sha256 = "${"a".repeat(64)}"
license_file = "./COPYING"
`,
  );
  const bundled = await loadDistribution(path, "linux");
  assert.deepEqual(bundled.layout.bubblewrap, {
    mode: "bundled",
    path: "/opt/pi-sandbox/bwrap",
  });
  assert.equal(bundled.bubblewrap.binary, join(temporaryDirectory, "bwrap"));
  assert.equal(bundled.bubblewrap.licenseFile, join(temporaryDirectory, "COPYING"));
  assert.deepEqual(bundled.bubblewrap.release, {
    mode: "bundled",
    path: "/opt/pi-sandbox/bwrap",
    version: "0.11.2",
    sha256: "a".repeat(64),
  });

  const smolvmManifest = `${validManifest}\n[platforms.linux.smolvm]\npath = "/opt/pinned-smolvm/smolvm"\nversion = "1.25.4"\n`;
  await writeFile(path, smolvmManifest);
  const smolvm = await loadDistribution(path, "linux");
  assert.deepEqual(smolvm.layout.smolvm, { path: "/opt/pinned-smolvm/smolvm", version: "1.25.4" });
  assert.deepEqual(smolvm.smolvm, smolvm.layout.smolvm);
  assert.match(createCompiledLayoutModule(smolvm.layout), /1\.25\.4/);
  for (const [from, to, error] of [
    ['version = "1.25.4"', 'version = "1.23.1"', /version must be 1.25.4/],
    ['path = "/opt/pinned-smolvm/smolvm"', 'path = "./smolvm"', /normalized absolute path/],
    ['version = "1.25.4"', 'version = "1.25.4"\nsha256 = "unused"', /sha256 is not recognized/],
  ]) {
    await writeFile(path, smolvmManifest.replace(from, to));
    await assert.rejects(loadDistribution(path, "linux"), error);
  }

  const nestedLayout = {
    ...distribution.layout,
    configDir: "/usr/libexec/pi-sandbox/config",
    configPath: "/usr/libexec/pi-sandbox/config/config.toml",
    defaultModelsPath: "/usr/libexec/pi-sandbox/config/models.json",
    libexecDir: "/opt/pi-sandbox",
  };
  expectSingleReplacement(
    renderLayoutText("/etc/pi-sandbox /usr/libexec/pi-sandbox", nestedLayout, "linux"),
    "/usr/libexec/pi-sandbox/config /opt/pi-sandbox",
  );

  await writeFile(path, `version = 3\nextension_manifests = []\nunknown = true\n`);
  await assert.rejects(loadDistribution(path, "linux"), /unknown is not recognized/);
  process.stdout.write("distribution manifest tests passed\n");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function expectSingleReplacement(actual, expected) {
  assert.equal(actual, expected);
}
