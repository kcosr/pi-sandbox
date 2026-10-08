#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoot = await mkdtemp(join(tmpdir(), "pi-sandbox-macos-install-"));

try {
  await verifyPayloadIntegrityChecks(temporaryRoot);

  const release = join(temporaryRoot, "release");
  const installRoot = join(temporaryRoot, "root");
  await createRelease(release);
  run(join(release, "install.sh"), [], { DESTDIR: installRoot });

  const installBase = join(installRoot, "usr/local/libexec/pi-sandbox");
  const launcher = join(installRoot, "usr/local/bin/pi-sandbox");
  const config = join(installRoot, "etc/pi-sandbox/config.toml");
  const models = join(installRoot, "etc/pi-sandbox/models.json");
  if ((await readlink(launcher)) !== "../libexec/pi-sandbox/pi-sandbox") {
    throw new Error("macOS launcher has the wrong target");
  }
  if (!(await lstat(join(installBase, "pi-sandbox"))).isFile()) {
    throw new Error("macOS executable was not installed");
  }
  const installedSbom = await lstat(join(installBase, "sbom.cdx.json"));
  if (!installedSbom.isFile() || (installedSbom.mode & 0o777) !== 0o644) {
    throw new Error("macOS SBOM was not installed as a regular readable file");
  }
  await writeFile(config, `${await readFile(config, "utf8")}# preserved\n`);
  run(join(release, "install.sh"), [], { DESTDIR: installRoot });
  if (!(await readFile(config, "utf8")).includes("# preserved")) {
    throw new Error("ordinary macOS upgrade replaced configuration");
  }

  const fixedDate = "20000101_000000";
  const fakeBin = join(temporaryRoot, "fake-bin");
  await mkdir(fakeBin, { recursive: true });
  await writeFile(join(fakeBin, "date"), `#!/bin/sh\nprintf '%s\\n' ${fixedDate}\n`, {
    mode: 0o755,
  });
  const existingConfigBackup = `${config}.bak.${fixedDate}`;
  const existingModelsBackup = `${models}.bak.${fixedDate}`;
  await writeFile(existingConfigBackup, "existing config backup\n");
  await writeFile(existingModelsBackup, "existing models backup\n");
  run(join(release, "install.sh"), ["--replace-config"], {
    DESTDIR: installRoot,
    PATH: `${fakeBin}:${process.env.PATH}`,
  });
  if ((await readFile(existingConfigBackup, "utf8")) !== "existing config backup\n") {
    throw new Error("macOS replace-config overwrote an existing config backup");
  }
  if ((await readFile(existingModelsBackup, "utf8")) !== "existing models backup\n") {
    throw new Error("macOS replace-config overwrote an existing models backup");
  }
  if (!(await readFile(`${config}.bak.${fixedDate}_1`, "utf8")).includes("# preserved")) {
    throw new Error("macOS replace-config did not create a collision-free config backup");
  }
  await readFile(`${models}.bak.${fixedDate}_1`, "utf8");

  run(join(release, "uninstall.sh"), [], { DESTDIR: installRoot });
  await expectMissing(launcher);
  await expectMissing(installBase);
  await readFile(config, "utf8");
  await readFile(models, "utf8");
  run(join(release, "uninstall.sh"), ["--remove-config"], { DESTDIR: installRoot });
  await expectMissing(config);
  await expectMissing(models);
  console.log("macOS staged installation smoke test passed");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function verifyPayloadIntegrityChecks(temporaryRoot) {
  const missingSbomRelease = join(temporaryRoot, "release-missing-sbom");
  await createRelease(missingSbomRelease);
  await rm(join(missingSbomRelease, "payload/pi-sandbox/sbom.cdx.json"));
  const sbomChecksums = join(missingSbomRelease, "SHA256SUMS");
  await writeFile(
    sbomChecksums,
    (await readFile(sbomChecksums, "utf8"))
      .split("\n")
      .filter((line) => !line.endsWith("payload/pi-sandbox/sbom.cdx.json"))
      .join("\n"),
  );
  expectFailure(
    join(missingSbomRelease, "install.sh"),
    [],
    { DESTDIR: join(temporaryRoot, "missing-sbom-root") },
    "release payload is incomplete",
  );

  const unlistedRelease = join(temporaryRoot, "release-unlisted");
  await createRelease(unlistedRelease);
  await writeFile(join(unlistedRelease, "payload/pi-sandbox/unlisted"), "unlisted\n");
  expectFailure(
    join(unlistedRelease, "install.sh"),
    [],
    { DESTDIR: join(temporaryRoot, "unlisted-root") },
    "release SHA256SUMS does not inventory the complete payload",
  );

  const symlinkRelease = join(temporaryRoot, "release-symlink");
  await createRelease(symlinkRelease);
  await symlink("package.json", join(symlinkRelease, "payload/pi-sandbox/unlisted-link"));
  expectFailure(
    join(symlinkRelease, "install.sh"),
    [],
    { DESTDIR: join(temporaryRoot, "symlink-root") },
    "release payload contains an unsupported file type",
  );

  const malformedRelease = join(temporaryRoot, "release-malformed-checksum");
  await createRelease(malformedRelease);
  const checksumPath = join(malformedRelease, "SHA256SUMS");
  await writeFile(
    checksumPath,
    `${await readFile(checksumPath, "utf8")}${"0".repeat(64)}  payload/pi-sandbox/../escape\n`,
  );
  expectFailure(
    join(malformedRelease, "install.sh"),
    [],
    { DESTDIR: join(temporaryRoot, "malformed-root") },
    "release SHA256SUMS has an invalid entry",
  );
}

async function createRelease(directory) {
  const payload = join(directory, "payload/pi-sandbox");
  for (const child of ["defaults", "theme", "assets", "export-html", "licenses"]) {
    await mkdir(join(payload, child), { recursive: true });
  }
  await copyFile(
    join(repositoryRoot, "scripts/install/macos-install.sh"),
    join(directory, "install.sh"),
  );
  await copyFile(
    join(repositoryRoot, "scripts/install/macos-uninstall.sh"),
    join(directory, "uninstall.sh"),
  );
  await chmod(join(directory, "install.sh"), 0o755);
  await chmod(join(directory, "uninstall.sh"), 0o755);
  await writeFile(
    join(payload, "pi-sandbox"),
    `#!/bin/sh
set -eu
operation=\${1:-}
shift
root=
if [ "\${1:-}" = --root ]; then root=$2; shift 2; fi
[ "$#" -eq 0 ]
grep -q '^config_version = 9$' "$root/etc/pi-sandbox/config.toml"
grep -q '"providers"' "$root/etc/pi-sandbox/models.json"
case "$operation" in
  --validate-installation) ;;
  --print-execution-backend) echo direct ;;
  *) exit 64 ;;
esac
`,
    { mode: 0o755 },
  );
  await writeFile(
    join(payload, "defaults/config.toml"),
    'config_version = 9\nmodels_file = "/etc/pi-sandbox/models.json"\n\n[sessions]\nretention_days = 0\n\n[audit]\nenabled = false\nfacility = "local0"\n\n[filesystem]\ncwd_writable = true\nhidden_paths = []\n\n[execution]\nbackend = "direct"\n\n[identity]\nmode = "disabled"\n\n[network]\nmode = "host"\n\n[environment.pi]\n\n[environment.sandbox]\n\n[environment.extensions]\n\n[extensions]\n',
  );
  await writeFile(join(payload, "defaults/models.json"), '{"providers":{}}\n');
  await writeFile(join(payload, "package.json"), '{"name":"pi-sandbox"}\n');
  await writeFile(join(payload, "release-manifest.json"), '{"manifestVersion":2}\n');
  await writeFile(join(payload, "photon_rs_bg.wasm"), "wasm\n");
  await writeFile(join(payload, "licenses/LICENSE"), "license\n");
  await writeFile(
    join(payload, "sbom.cdx.json"),
    '{"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"components":[]}\n',
  );
  const files = await regularFiles(payload);
  const checksums = await Promise.all(
    files.map(async (file) => {
      const digest = createHash("sha256")
        .update(await readFile(file))
        .digest("hex");
      return `${digest}  payload/pi-sandbox/${relative(payload, file)}`;
    }),
  );
  await writeFile(join(directory, "SHA256SUMS"), `${checksums.sort().join("\n")}\n`);
}

async function regularFiles(directory) {
  const output = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...(await regularFiles(path)));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}

function run(command, args, environment) {
  const result = spawnSync(command, args, {
    env: { ...process.env, ...environment },
    encoding: "utf8",
  });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr || result.stdout}`);
}

function expectFailure(command, args, environment, expectedMessage) {
  const result = spawnSync(command, args, {
    env: { ...process.env, ...environment },
    encoding: "utf8",
  });
  if (result.status === 0) throw new Error(`${command} unexpectedly succeeded`);
  const output = `${result.stderr}${result.stdout}`;
  if (!output.includes(expectedMessage)) {
    throw new Error(`${command} failed without ${JSON.stringify(expectedMessage)}: ${output}`);
  }
}

async function expectMissing(path) {
  try {
    await lstat(path);
    throw new Error(`expected missing path: ${path}`);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}
