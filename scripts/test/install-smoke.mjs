#!/usr/bin/env node

import { spawnSync } from "node:child_process";
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
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const temporaryRoot = await mkdtemp(
  path.join(process.env.PI_SANDBOX_TEST_TMPDIR ?? os.tmpdir(), "pi-sandbox-install-"),
);

try {
  const release1 = path.join(temporaryRoot, "release-1");
  const release2 = path.join(temporaryRoot, "release-2");
  const bundledRelease = path.join(temporaryRoot, "release-bundled");
  const installRoot = path.join(temporaryRoot, "root");
  await createRelease(release1, "1");
  await createRelease(release2, "2");
  await createRelease(bundledRelease, "bundled", true);

  const bundledRoot = path.join(temporaryRoot, "bundled-root");
  const bundledInstall = run(path.join(bundledRelease, "install.sh"), [], {
    DESTDIR: bundledRoot,
  });
  const bundledExecutable = path.join(bundledRoot, "usr/libexec/pi-sandbox/bwrap");
  await assertMode(bundledExecutable, 0o755);
  assertIncludes(
    bundledInstall.stdout,
    `  ${bundledExecutable} (bundled Bubblewrap executable)`,
    "bundled Bubblewrap path",
  );

  assertRunFails(path.join(release1, "install.sh"), [], { DESTDIR: "relative/root" });
  assertRunFails(path.join(release1, "install.sh"), [], {
    DESTDIR: `${installRoot}\nforged-status-line`,
  });
  assertRunFails(path.join(release1, "install.sh"), [], {
    DESTDIR: `${installRoot}\u009b31m`,
  });
  const initialInstall = run(path.join(release1, "install.sh"), [], {
    DESTDIR: `${installRoot}//`,
  });

  const installBase = path.join(installRoot, "usr/libexec/pi-sandbox");
  const launcher = path.join(installRoot, "usr/bin/pi-sandbox");
  const broker = path.join(installBase, "pi-sandbox-identity-broker");
  const systemdDirectory = path.join(installRoot, "usr/lib/systemd/system");
  const socketUnit = path.join(systemdDirectory, "pi-sandbox-identity-broker.socket");
  const serviceUnit = path.join(systemdDirectory, "pi-sandbox-identity-broker@.service");
  const auditCollector = path.join(installBase, "pi-sandbox-audit-collector");
  const auditSocketUnit = path.join(systemdDirectory, "pi-sandbox-audit.socket");
  const auditServiceUnit = path.join(systemdDirectory, "pi-sandbox-audit@.service");
  const etcDirectory = path.join(installRoot, "etc/pi-sandbox");
  const config = path.join(etcDirectory, "config.toml");
  const models = path.join(etcDirectory, "models.json");
  assertIncludes(
    initialInstall.stdout,
    `  ${installBase}/pi-sandbox (executable)`,
    "installed executable path",
  );
  assertIncludes(initialInstall.stdout, `  ${broker} (identity broker executable)`, "broker path");
  assertIncludes(
    initialInstall.stdout,
    `  ${launcher} -> ${installBase}/pi-sandbox`,
    "installed launcher path",
  );
  assertIncludes(initialInstall.stdout, `  ${config} (installed)`, "installed configuration path");
  assertIncludes(initialInstall.stdout, `  ${models} (installed)`, "installed models path");
  assertEqual(await readlink(launcher), "../libexec/pi-sandbox/pi-sandbox", "launcher link");
  assertEqual(
    await readlink(socketUnit),
    "../../../libexec/pi-sandbox/systemd/pi-sandbox-identity-broker.socket",
    "socket unit link",
  );
  assertEqual(
    await readlink(serviceUnit),
    "../../../libexec/pi-sandbox/systemd/pi-sandbox-identity-broker@.service",
    "service unit link",
  );
  await assertMode(path.join(installBase, "pi-sandbox"), 0o755);
  await assertMode(broker, 0o755);
  await assertMode(path.join(installBase, "sbom.cdx.json"), 0o644);
  await assertMode(auditCollector, 0o755);
  for (const unit of [auditSocketUnit, auditServiceUnit]) {
    assertEqual(
      await readlink(unit),
      `../../../libexec/pi-sandbox/systemd/${path.basename(unit)}`,
      "audit unit link",
    );
  }
  await assertMode(path.join(installBase, "defaults/config.toml"), 0o644);
  assertEqual(await readFile(config, "utf8"), configContents("1"), "initial config");
  assertEqual(await readFile(models, "utf8"), modelsContents("1"), "initial models");
  assertEqual(
    await readFile(path.join(installBase, "assets/release.txt"), "utf8"),
    "release 1\n",
    "initial adjacent asset",
  );

  const operatorConfig = `${configContents("1")}operator = "preserved"\n`;
  const operatorModels = `${JSON.stringify({ valid: true, release: "1", operator: "preserved" })}\n`;
  await writeFile(config, operatorConfig);
  await writeFile(models, operatorModels);
  await chmod(config, 0o600);
  await chmod(models, 0o640);
  const ordinaryUpgrade = run(path.join(release2, "install.sh"), [], { DESTDIR: installRoot });
  assertIncludes(ordinaryUpgrade.stdout, `  ${config} (preserved)`, "preserved configuration");
  assertIncludes(ordinaryUpgrade.stdout, `  ${models} (preserved)`, "preserved models");
  assertEqual(await readFile(config, "utf8"), operatorConfig, "preserved config");
  assertEqual(await readFile(models, "utf8"), operatorModels, "preserved models");
  await assertMode(config, 0o600);
  await assertMode(models, 0o640);
  assertEqual(
    await readFile(path.join(installBase, "assets/release.txt"), "utf8"),
    "release 2\n",
    "upgraded adjacent asset",
  );
  assertEqual(
    await readFile(path.join(installBase, "defaults/config.toml"), "utf8"),
    configContents("2"),
    "updated packaged default",
  );

  const customModelsRoot = path.join(temporaryRoot, "custom-models-root");
  run(path.join(release1, "install.sh"), [], { DESTDIR: customModelsRoot });
  const customConfig = path.join(customModelsRoot, "etc/pi-sandbox/config.toml");
  const packagedModels = path.join(customModelsRoot, "etc/pi-sandbox/models.json");
  const customModels = path.join(customModelsRoot, "etc/pi-sandbox/site-models.json");
  await writeFile(
    customConfig,
    configContents("1").replace("/etc/pi-sandbox/models.json", "/etc/pi-sandbox/site-models.json"),
  );
  await writeFile(customModels, modelsContents("1"));
  await rm(packagedModels);
  const customModelsUpgrade = run(path.join(release2, "install.sh"), [], {
    DESTDIR: customModelsRoot,
  });
  if (customModelsUpgrade.stdout.includes(packagedModels)) {
    throw new Error("installer reported an absent packaged model path");
  }
  assertEqual(await readFile(customModels, "utf8"), modelsContents("1"), "custom models preserved");

  const replacement = run(path.join(release2, "install.sh"), ["--replace-config"], {
    DESTDIR: installRoot,
  });
  assertEqual(await readFile(config, "utf8"), configContents("2"), "replaced config");
  assertEqual(await readFile(models, "utf8"), modelsContents("2"), "replaced models");
  await assertMode(config, 0o644);
  await assertMode(models, 0o644);
  const etcEntries = await readdir(etcDirectory);
  const configBackups = etcEntries.filter((entry) => entry.startsWith("config.toml.bak."));
  const modelBackups = etcEntries.filter((entry) => entry.startsWith("models.json.bak."));
  if (configBackups.length !== 1 || modelBackups.length !== 1) {
    throw new Error(`replacement created unexpected backups: ${etcEntries.join(", ")}`);
  }
  assertIncludes(
    replacement.stdout,
    `  ${path.join(etcDirectory, configBackups[0])} (configuration backup)`,
    "configuration backup path",
  );
  assertIncludes(
    replacement.stdout,
    `  ${path.join(etcDirectory, modelBackups[0])} (model catalog backup)`,
    "model backup path",
  );
  assertEqual(
    configBackups[0]?.slice("config.toml.bak.".length),
    modelBackups[0]?.slice("models.json.bak.".length),
    "shared backup identifier",
  );
  assertEqual(
    await readFile(path.join(etcDirectory, configBackups[0]), "utf8"),
    operatorConfig,
    "config backup",
  );
  assertEqual(
    await readFile(path.join(etcDirectory, modelBackups[0]), "utf8"),
    operatorModels,
    "models backup",
  );

  const corruptRelease = path.join(temporaryRoot, "release-corrupt");
  await createRelease(corruptRelease, "3");
  await writeFile(path.join(corruptRelease, "payload/pi-sandbox/assets/release.txt"), "tampered\n");
  assertRunFails(path.join(corruptRelease, "install.sh"), [], { DESTDIR: installRoot });
  assertEqual(
    await readFile(path.join(installBase, "assets/release.txt"), "utf8"),
    "release 2\n",
    "checksum failure preserved installed payload",
  );

  const missingSbomRelease = path.join(temporaryRoot, "release-missing-sbom");
  await createRelease(missingSbomRelease, "3");
  await rm(path.join(missingSbomRelease, "payload/pi-sandbox/sbom.cdx.json"));
  const sbomChecksums = path.join(missingSbomRelease, "SHA256SUMS");
  await writeFile(
    sbomChecksums,
    (await readFile(sbomChecksums, "utf8"))
      .split("\n")
      .filter((line) => !line.endsWith("payload/pi-sandbox/sbom.cdx.json"))
      .join("\n"),
  );
  assertRunFails(path.join(missingSbomRelease, "install.sh"), [], { DESTDIR: installRoot });
  assertEqual(
    await readFile(path.join(installBase, "assets/release.txt"), "utf8"),
    "release 2\n",
    "missing SBOM preserves installed payload",
  );

  const invalidRoot = path.join(temporaryRoot, "invalid-config-root");
  run(path.join(release1, "install.sh"), [], { DESTDIR: invalidRoot });
  await writeFile(path.join(invalidRoot, "etc/pi-sandbox/config.toml"), "invalid = true\n");
  assertRunFails(path.join(release2, "install.sh"), [], { DESTDIR: invalidRoot });
  assertEqual(
    await readFile(path.join(invalidRoot, "usr/libexec/pi-sandbox/assets/release.txt"), "utf8"),
    "release 1\n",
    "validation failure preserved installed payload",
  );

  const occupiedLauncherRoot = path.join(temporaryRoot, "occupied-launcher-root");
  await mkdir(path.join(occupiedLauncherRoot, "usr/bin"), { recursive: true });
  await writeFile(path.join(occupiedLauncherRoot, "usr/bin/pi-sandbox"), "unrelated\n");
  assertRunFails(path.join(release1, "install.sh"), [], { DESTDIR: occupiedLauncherRoot });
  await assertMissing(path.join(occupiedLauncherRoot, "usr/libexec/pi-sandbox"));

  for (const unit of ["pi-sandbox-audit.socket", "pi-sandbox-audit@.service"]) {
    const occupiedRoot = path.join(temporaryRoot, `occupied-${unit}`);
    const unitPath = path.join(occupiedRoot, "usr/lib/systemd/system", unit);
    await mkdir(path.dirname(unitPath), { recursive: true });
    await writeFile(unitPath, "unrelated\n");
    assertRunFails(path.join(release1, "install.sh"), [], { DESTDIR: occupiedRoot });
    await assertMissing(path.join(occupiedRoot, "usr/libexec/pi-sandbox"));
    assertEqual(await readFile(unitPath, "utf8"), "unrelated\n", "unmanaged audit unit preserved");
    assertRunFails(path.join(release1, "uninstall.sh"), [], { DESTDIR: occupiedRoot });
    assertEqual(
      await readFile(unitPath, "utf8"),
      "unrelated\n",
      "uninstall preserves unmanaged audit unit",
    );
  }

  const unsafeUninstallRoot = path.join(temporaryRoot, "unsafe-uninstall-root");
  run(path.join(release1, "install.sh"), [], { DESTDIR: unsafeUninstallRoot });
  const unsafeAuditUnit = path.join(
    unsafeUninstallRoot,
    "usr/lib/systemd/system/pi-sandbox-audit.socket",
  );
  await rm(unsafeAuditUnit);
  await writeFile(unsafeAuditUnit, "operator-managed\n");
  assertRunFails(path.join(release1, "uninstall.sh"), [], { DESTDIR: unsafeUninstallRoot });
  await assertMode(path.join(unsafeUninstallRoot, "usr/libexec/pi-sandbox/pi-sandbox"), 0o755);
  assertEqual(
    await readlink(path.join(unsafeUninstallRoot, "usr/bin/pi-sandbox")),
    "../libexec/pi-sandbox/pi-sandbox",
    "failed uninstall preserves launcher",
  );

  const symlinkConfigRoot = path.join(temporaryRoot, "symlink-config-root");
  const sentinel = path.join(temporaryRoot, "sentinel");
  await writeFile(sentinel, "do not replace\n");
  await mkdir(path.join(symlinkConfigRoot, "etc/pi-sandbox"), { recursive: true });
  await symlink(sentinel, path.join(symlinkConfigRoot, "etc/pi-sandbox/config.toml"));
  assertRunFails(path.join(release1, "install.sh"), ["--replace-config"], {
    DESTDIR: symlinkConfigRoot,
  });
  assertEqual(await readFile(sentinel, "utf8"), "do not replace\n", "symlink target");

  const unrelated = path.join(etcDirectory, "operator-note.txt");
  const usersDirectory = path.join(etcDirectory, "users.d");
  const groupsDirectory = path.join(etcDirectory, "groups.d");
  const groups = path.join(groupsDirectory, "admin.toml");
  const groupContents =
    'version = 7\ngroup = "admin"\n[overrides.tools.bash]\nmode = "ask"\nsession_grant = "offer"\n';
  await assertMissing(groupsDirectory);
  await mkdir(groupsDirectory, { mode: 0o755 });
  await writeFile(groups, groupContents, { mode: 0o600 });
  const users = path.join(usersDirectory, "1000.toml");
  await writeFile(unrelated, "keep\n");
  await mkdir(usersDirectory, { mode: 0o755 });
  await writeFile(users, 'version = 7\nuid = 1000\n\n[overrides.execution]\nbackend = "direct"\n', {
    mode: 0o600,
  });
  run(path.join(release2, "uninstall.sh"), [], { DESTDIR: installRoot });
  await assertMissing(launcher);
  await assertMissing(socketUnit);
  await assertMissing(serviceUnit);
  await assertMissing(auditSocketUnit);
  await assertMissing(auditServiceUnit);
  await assertMissing(installBase);
  assertEqual(await readFile(config, "utf8"), configContents("2"), "retained config");
  assertEqual(await readFile(models, "utf8"), modelsContents("2"), "retained models");

  run(path.join(release2, "install.sh"), [], { DESTDIR: installRoot });
  run(path.join(release2, "uninstall.sh"), ["--remove-config"], { DESTDIR: installRoot });
  await assertMissing(config);
  await assertMissing(models);
  assertEqual(await readFile(unrelated, "utf8"), "keep\n", "unrelated configuration");
  assertEqual(
    await readFile(users, "utf8"),
    'version = 7\nuid = 1000\n\n[overrides.execution]\nbackend = "direct"\n',
    "retained user override",
  );
  assertEqual(await readFile(groups, "utf8"), groupContents, "retained group override");
  assertEqual(
    await readFile(path.join(etcDirectory, configBackups[0]), "utf8"),
    operatorConfig,
    "retained backup",
  );

  console.log("release installation smoke test passed");
} finally {
  await rm(temporaryRoot, { recursive: true, force: true });
}

async function createRelease(directory, release, bundledBubblewrap = false) {
  const payload = path.join(directory, "payload/pi-sandbox");
  await mkdir(path.join(payload, "defaults"), { recursive: true });
  await mkdir(path.join(payload, "theme"));
  await mkdir(path.join(payload, "assets"));
  await mkdir(path.join(payload, "export-html"));
  await mkdir(path.join(payload, "systemd"));
  await copyFile(
    path.join(repositoryRoot, "scripts/install/install.sh"),
    path.join(directory, "install.sh"),
  );
  if (bundledBubblewrap) {
    const installerPath = path.join(directory, "install.sh");
    const installer = (await readFile(installerPath, "utf8"))
      .replace("bubblewrap_mode=system", "bubblewrap_mode=bundled")
      .replaceAll("/usr/bin/bwrap", "/usr/libexec/pi-sandbox/bwrap");
    await writeFile(installerPath, installer);
  }
  await copyFile(
    path.join(repositoryRoot, "scripts/install/uninstall.sh"),
    path.join(directory, "uninstall.sh"),
  );
  await chmod(path.join(directory, "install.sh"), 0o755);
  await chmod(path.join(directory, "uninstall.sh"), 0o755);
  await writeFile(
    path.join(payload, "pi-sandbox"),
    `#!/bin/sh
set -eu
operation=\${1:-}
case "$operation" in --validate-installation|--print-execution-backend) ;; *) exit 64 ;; esac
shift
root=
if [ "\${1:-}" = --root ]; then
  [ "$#" -eq 2 ] || exit 64
  root=$2
elif [ "$#" -ne 0 ]; then
  exit 64
fi
config="$root/etc/pi-sandbox/config.toml"
grep -q '^valid = true$' "$config"
models_path=$(awk -F '"' '/^models_file = "/ { print $2; exit }' "$config")
[ -n "$models_path" ]
grep -q '"valid":true' "$root$models_path"
[ "$operation" != --print-execution-backend ] || echo bubblewrap
`,
    { mode: 0o755 },
  );
  await writeFile(path.join(payload, "package.json"), `${JSON.stringify({ release })}\n`);
  await writeFile(path.join(payload, "pi-sandbox-identity-broker"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  await writeFile(path.join(payload, "pi-sandbox-audit-collector"), "#!/bin/sh\nexit 0\n", {
    mode: 0o755,
  });
  await writeFile(
    path.join(payload, "systemd/pi-sandbox-audit.socket"),
    "[Socket]\nListenStream=/run/pi-sandbox-audit/collector.sock\n",
  );
  await writeFile(
    path.join(payload, "systemd/pi-sandbox-audit@.service"),
    "[Service]\nStandardInput=socket\n",
  );
  if (bundledBubblewrap) {
    await writeFile(
      path.join(payload, "bwrap"),
      "#!/bin/sh\n[ \"${1:-}\" != --help ] || printf '%s\\n' '--unshare-user --disable-userns --assert-userns-disabled --json-status-fd --seccomp --remount-ro'\n",
      { mode: 0o755 },
    );
  }
  await writeFile(
    path.join(payload, "systemd/pi-sandbox-identity-broker.socket"),
    "[Socket]\nListenStream=/run/pi-sandbox-identity/broker.sock\n",
  );
  await writeFile(
    path.join(payload, "systemd/pi-sandbox-identity-broker@.service"),
    "[Service]\nStandardInput=socket\n",
  );
  await writeFile(path.join(payload, "theme/dark.json"), "{}\n");
  await writeFile(path.join(payload, "assets/release.txt"), `release ${release}\n`);
  await writeFile(path.join(payload, "export-html/index.html"), "<!doctype html>\n");
  await writeFile(path.join(payload, "photon_rs_bg.wasm"), `wasm-${release}\n`);
  await writeFile(path.join(payload, "defaults/config.toml"), configContents(release));
  await writeFile(path.join(payload, "defaults/models.json"), modelsContents(release));
  await writeFile(
    path.join(payload, "release-manifest.json"),
    `${JSON.stringify({ manifestVersion: 1, release })}\n`,
  );

  await writeFile(
    path.join(payload, "sbom.cdx.json"),
    '{"bomFormat":"CycloneDX","specVersion":"1.6","version":1,"components":[]}\n',
  );
  const files = await regularFiles(path.join(directory, "payload"));
  const checksums = files
    .sort()
    .map((filename) => {
      const relative = path.relative(directory, filename);
      return `${sha256Sync(filename)}  ${relative}`;
    })
    .join("\n");
  await writeFile(path.join(directory, "SHA256SUMS"), `${checksums}\n`);
}

function configContents(release) {
  return `valid = true\nrelease = "${release}"\nmodels_file = "/etc/pi-sandbox/models.json"\n`;
}

function modelsContents(release) {
  return `${JSON.stringify({ valid: true, release })}\n`;
}

function sha256Sync(filename) {
  const result = spawnSync("sha256sum", [filename], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`sha256sum failed for ${filename}: ${result.stderr}`);
  return result.stdout.split(/\s/, 1)[0];
}

function run(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} failed (${result.status}):\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function assertRunFails(command, args, environment) {
  const result = spawnSync(command, args, {
    cwd: repositoryRoot,
    env: { ...process.env, ...environment },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error !== undefined) throw result.error;
  if (result.status === 0) throw new Error(`${command} unexpectedly succeeded`);
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) throw new Error(`${label}: expected ${expected}, got ${actual}`);
}

function assertIncludes(actual, expected, label) {
  if (!actual.includes(expected))
    throw new Error(`${label}: expected output to contain ${expected}`);
}

async function assertMode(filename, expected) {
  const actual = (await lstat(filename)).mode & 0o777;
  if (actual !== expected) {
    throw new Error(`${filename} has mode ${actual.toString(8)}, expected ${expected.toString(8)}`);
  }
}

async function assertMissing(filename) {
  try {
    await lstat(filename);
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`expected path to be absent: ${filename}`);
}

async function regularFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await regularFiles(filename)));
    else if (entry.isFile()) files.push(filename);
    else throw new Error(`unexpected release file type: ${filename}`);
  }
  return files;
}
