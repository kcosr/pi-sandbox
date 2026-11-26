#!/usr/bin/env node
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { URL } from "node:url";
import {
  createCompiledLayoutModule,
  loadDistribution,
  releaseLayout,
} from "../build/distribution.mjs";
import { renderLayoutText } from "../build/layout-render.mjs";

const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-sandbox-distribution-test-"));
try {
  const path = join(temporaryDirectory, "distribution.toml");
  const local = `version = 4
extension_manifests = ["./extension.json"]
[platforms.linux]
libexec_dir = "/opt/example/libexec"
launcher_path = "/opt/example/bin/pi-sandbox"
[platforms.linux.configuration]
source = "local"
config_dir = "/opt/example/etc"
allow_config_override = false
[platforms.linux.bubblewrap]
mode = "system"
path = "/opt/example/bin/bwrap"
`;
  const load = async (text, platform = "linux", options) => {
    await writeFile(path, text);
    return loadDistribution(path, platform, options);
  };
  const distribution = await load(local);
  assert.deepEqual(distribution.layout.configuration, {
    source: "local",
    configDir: "/opt/example/etc",
    configPath: "/opt/example/etc/config.toml",
    defaultModelsPath: "/opt/example/etc/models.json",
    allowConfigOverride: false,
  });
  assert.deepEqual(distribution.bubblewrap.release, {
    mode: "system",
    path: "/opt/example/bin/bwrap",
  });
  assert.equal(
    (await load(`skills_source = "./company-skills"\n${local}`)).skillsSource,
    join(temporaryDirectory, "company-skills"),
  );
  for (const invalid of ['""', "false", "[]", "{}", '"bad\\u0000path"'])
    await assert.rejects(load(`skills_source = ${invalid}\n${local}`), /skills_source|valid TOML/u);
  for (const version of [1, 2, 3])
    await assert.rejects(
      load(local.replace("version = 4", `version = ${version}`)),
      /version must be 4/u,
    );
  for (const declaration of ["", 'allow_config_override = "true"'])
    await assert.rejects(
      load(local.replace("allow_config_override = false", declaration)),
      /allow_config_override must be boolean/u,
    );
  const configurable = await load(
    local.replace("allow_config_override = false", "allow_config_override = true"),
  );
  assert.equal(configurable.layout.configuration.allowConfigOverride, true);
  assert.match(createCompiledLayoutModule(configurable.layout), /"allowConfigOverride":true/u);
  for (const obsolete of [
    "allow_config_override = false",
    'config_dir = "/etc/legacy"',
    'service_dir = "/etc/systemd"',
    'identity_socket_path = "/run/old.sock"',
    'audit_socket_path = "/run/old.sock"',
  ])
    await assert.rejects(
      load(local.replace("[platforms.linux]", `[platforms.linux]\n${obsolete}`)),
      /not recognized/u,
    );
  const service = local.replace(
    'source = "local"\nconfig_dir = "/opt/example/etc"\nallow_config_override = false',
    'source = "service"\n[platforms.linux.configuration.endpoint]\ntransport = "unix"\nsocket_path = "/run/pi-sandbox/service.sock"',
  );
  assert.equal(
    (await load(service)).layout.configuration.endpoint.socketPath,
    "/run/pi-sandbox/service.sock",
  );
  await assert.rejects(
    load(service.replace('source = "service"', 'source = "service"\nallow_config_override = true')),
    /not recognized/u,
  );
  const password = randomBytes(40).toString("base64");
  const passwordFile = join(temporaryDirectory, "password");
  await writeFile(passwordFile, password + "\n", { mode: 0o600 });
  const https = service.replace(
    'transport = "unix"\nsocket_path = "/run/pi-sandbox/service.sock"',
    `transport = "https"\nurl = "https://config.example.test/v1/service"\nbasic_username = "distribution"\nbasic_password_file = "${passwordFile}"\nsend_machine_id = false`,
  );
  const remote = await load(https);
  assert.equal(remote.layout.configuration.endpoint.basicPassword, password);
  const metadata = JSON.stringify(releaseLayout(remote.layout));
  assert.ok(!metadata.includes(password) && !metadata.includes(passwordFile));
  assert.equal(releaseLayout(remote.layout).configuration.endpoint.tlsTrust, "public");
  assert.ok(createCompiledLayoutModule(remote.layout).includes(password));
  const originalUrl = "https://config.example.test/v1/service";
  for (const platform of ["linux", "darwin"]) {
    for (const source of ["service", "local"]) {
      let descriptor = https;
      if (source === "local")
        descriptor = descriptor
          .replace(
            'source = "service"',
            'source = "local"\nconfig_dir = "/opt/example/etc"\nallow_config_override = false',
          )
          .replace("configuration.endpoint]", "configuration.audit_endpoint]");
      if (platform === "darwin")
        descriptor = descriptor
          .replaceAll("platforms.linux", "platforms.darwin")
          .replace(/\n\[platforms\.darwin\.bubblewrap\][\s\S]*$/u, "\n");
      for (const suffix of [
        "/v1/service",
        "/pi-sandbox-macos",
        "/pi-sandbox-linux",
        "/service%20path/",
        "",
      ]) {
        const url = `https://config.example.test:9443${suffix}`;
        const configured = await load(descriptor.replace(originalUrl, url), platform);
        const endpoint =
          source === "service"
            ? configured.layout.configuration.endpoint
            : configured.layout.configuration.auditEndpoint;
        const expectedUrl = new URL(url).href;
        assert.equal(endpoint.url, expectedUrl);
        assert.ok(createCompiledLayoutModule(configured.layout).includes(expectedUrl));
        const published = releaseLayout(configured.layout).configuration;
        assert.equal(
          (source === "service" ? published.endpoint : published.auditEndpoint).url,
          expectedUrl,
        );
      }
      for (const [authored, pathname] of [
        ["/old/../service", "/service"],
        ["/./service", "/service"],
        ["/service path", "/service%20path"],
        ["//service", "//service"],
      ]) {
        const configured = await load(
          descriptor.replace(originalUrl, `https://config.example.test${authored}`),
          platform,
        );
        const endpoint =
          source === "service"
            ? configured.layout.configuration.endpoint
            : configured.layout.configuration.auditEndpoint;
        assert.equal(endpoint.url, `https://config.example.test${pathname}`);
      }
      for (const invalid of [
        "http://config.example.test/pi-sandbox-macos",
        "https://user:password@config.example.test/pi-sandbox-macos",
        "https://config.example.test/pi-sandbox-macos?token=secret",
        "https://config.example.test/pi-sandbox-macos?",
        "https://config.example.test/pi-sandbox-macos#fragment",
        "https://config.example.test/pi-sandbox-macos#",
      ])
        await assert.rejects(
          load(descriptor.replace(originalUrl, invalid), platform),
          /HTTPS|credentials\/query\/fragment/u,
        );
    }
  }
  await assert.rejects(
    load(https.replace("send_machine_id = false", "send_machine_id = true")),
    /macOS/u,
  );
  await writeFile(passwordFile, "short");
  await assert.rejects(load(https), /32–8192/u);
  const installer = renderLayoutText(
    await readFile(new URL("../install/install.sh", import.meta.url), "utf8"),
    distribution.layout,
    "linux",
  );
  assert.match(installer, /install_base="\$\{root_prefix\}\/opt\/example\/libexec"/u);
  assert.match(installer, /configuration_source=local/u);
  assert.doesNotMatch(installer, /root_prefix\}\/etc\/pi-sandbox/u);
  assert.match(installer, /bubblewrap_runtime="\/opt\/example\/bin\/bwrap"/u);
  const serviceInstaller = renderLayoutText(
    "configuration_source=local",
    (await load(service)).layout,
    "linux",
  );
  assert.equal(serviceInstaller, "configuration_source=service");
  const nested = {
    ...distribution.layout,
    configuration: {
      ...distribution.layout.configuration,
      configDir: "/usr/libexec/pi-sandbox/config",
    },
    libexecDir: "/opt/pi-sandbox",
  };
  assert.equal(
    renderLayoutText("/etc/pi-sandbox /usr/libexec/pi-sandbox", nested, "linux"),
    "/usr/libexec/pi-sandbox/config /opt/pi-sandbox",
  );
  const bundled = await load(
    local.replace(
      'mode = "system"\npath = "/opt/example/bin/bwrap"',
      `mode = "bundled"\nbinary = "./bwrap"\nversion = "0.11.2"\nsha256 = "${"a".repeat(64)}"\nlicense_file = "./COPYING"`,
    ),
  );
  assert.equal(bundled.layout.bubblewrap.path, "/opt/example/libexec/bwrap");
  assert.equal(bundled.bubblewrap.binary, join(temporaryDirectory, "bwrap"));
  const darwin = local
    .replaceAll("platforms.linux", "platforms.darwin")
    .replace(/\n\[platforms\.darwin\.bubblewrap\][\s\S]*$/u, "\n");
  const darwinService = https
    .replaceAll("platforms.linux", "platforms.darwin")
    .replace(/\n\[platforms\.darwin\.bubblewrap\][\s\S]*$/u, "\n");
  const macosPackage = { macosPackage: true };
  await writeFile(passwordFile, password, { mode: 0o600 });
  const installedApp = await load(darwinService, "darwin", macosPackage);
  assert.equal(
    installedApp.layout.libexecDir,
    "/Applications/Pi Sandbox.app/Contents/Resources/client",
  );
  assert.equal(installedApp.layout.launcherPath, "/usr/local/bin/pi-sandbox");
  assert.equal(installedApp.layout.configuration.endpoint.url, originalUrl);
  assert.equal((await load(darwinService, "darwin")).layout.libexecDir, "/opt/example/libexec");
  const darwinWithSkills = `skills_source = "./shared-skills"\n${darwinService}`;
  await assert.rejects(
    load(darwinWithSkills, "darwin", macosPackage),
    /do not support distribution skills_source/u,
  );
  assert.equal(
    (await load(darwinWithSkills, "darwin")).skillsSource,
    join(temporaryDirectory, "shared-skills"),
  );
  await assert.rejects(load(darwin, "darwin", macosPackage), /require a service-source/u);
  await assert.rejects(load(https, "linux", macosPackage), /require a macOS build host/u);
  for (const architecture of ["x64", "arm64"]) {
    await writeFile(path, darwin);
    assert.equal(
      (await loadDistribution(path, "darwin", architecture)).layout.bubblewrap,
      undefined,
    );
  }
  await assert.rejects(
    load(
      service
        .replaceAll("platforms.linux", "platforms.darwin")
        .replace(/\n\[platforms\.darwin\.bubblewrap\][\s\S]*$/u, "\n"),
      "darwin",
    ),
    /Unix service endpoints require Linux/u,
  );
  await assert.rejects(
    load(`${local}\n[platforms.linux.smolvm]\npath = "/old"`),
    /not recognized/u,
  );
  process.stdout.write("distribution manifest tests passed\n");
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
