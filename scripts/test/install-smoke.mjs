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
import { renderLayoutText } from "../build/layout-render.mjs";
import { skillCandidateFixture, verifySkillInstallation } from "./skill-install-fixtures.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const defaultLayout = {
  configuration: {
    source: "local",
    configDir: "/etc/pi-sandbox",
    allowConfigOverride: false,
  },
  libexecDir: "/usr/libexec/pi-sandbox",
  launcherPath: "/usr/bin/pi-sandbox",
  bubblewrap: { mode: "system", path: "/usr/bin/bwrap" },
};
const defaultPolicy = (
  await readFile(path.join(repositoryRoot, "config/default/config.toml"), "utf8")
).replace(/\[skills\][\s\S]*?(?=\n\[)/u, "");
const temporaryRoot = await mkdtemp(
  path.join(process.env.PI_SANDBOX_TEST_TMPDIR ?? os.tmpdir(), "pi-sandbox-install-"),
);

try {
  await verifySkillInstallation({
    root: path.join(temporaryRoot, "shared-skills"),
    createRelease: (directory) => createRelease(directory, "skills"),
    libexecDir: "/usr/libexec/pi-sandbox",
  });
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
  const etcDirectory = path.join(installRoot, "etc/pi-sandbox");
  const config = path.join(etcDirectory, "config.toml");
  const models = path.join(etcDirectory, "models.json");
  assertIncludes(
    initialInstall.stdout,
    `  ${installBase}/pi-sandbox (executable)`,
    "installed executable path",
  );
  assertIncludes(
    initialInstall.stdout,
    `  ${launcher} -> ${installBase}/pi-sandbox`,
    "installed launcher path",
  );
  assertIncludes(initialInstall.stdout, `  ${config} (installed)`, "installed configuration path");
  assertIncludes(initialInstall.stdout, `  ${models} (installed)`, "installed models path");
  assertEqual(await readlink(launcher), "../libexec/pi-sandbox/pi-sandbox", "launcher link");
  await assertMode(path.join(installBase, "pi-sandbox"), 0o755);
  await assertMode(path.join(installBase, "defaults/config.toml"), 0o644);
  assertEqual(await readFile(config, "utf8"), configContents("1"), "initial config");
  assertEqual(await readFile(models, "utf8"), modelsContents("1"), "initial models");
  assertEqual(
    await readFile(path.join(installBase, "assets/release.txt"), "utf8"),
    "release 1\n",
    "initial adjacent asset",
  );

  const operatorConfig = `${configContents("1")}# operator = "preserved"\n`;
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

  // These staged candidates model the version gate; parser tests exercise full schema semantics.
  const oldSchemaRoot = path.join(temporaryRoot, "old-schema-root");
  run(path.join(release1, "install.sh"), [], { DESTDIR: oldSchemaRoot });
  const oldSchemaConfig = path.join(oldSchemaRoot, "etc/pi-sandbox/config.toml");
  const oldSchemaBinary = path.join(oldSchemaRoot, "usr/libexec/pi-sandbox/pi-sandbox");
  const retainedBinary = `${await readFile(oldSchemaBinary, "utf8")}# retained binary marker\n`;
  const retainedPolicy = configContents("1").replace("config_version = 16", "config_version = 14");
  await writeFile(oldSchemaBinary, retainedBinary);
  await writeFile(oldSchemaConfig, retainedPolicy);
  const oldSchemaFailure = assertRunFails(path.join(release2, "install.sh"), [], {
    DESTDIR: oldSchemaRoot,
  });
  assertIncludes(
    oldSchemaFailure.stderr,
    "config.config_version must be the integer 16",
    "old schema diagnostic",
  );
  assertEqual(
    await readFile(oldSchemaConfig, "utf8"),
    retainedPolicy,
    "old schema policy preserved",
  );
  assertEqual(
    await readFile(oldSchemaBinary, "utf8"),
    retainedBinary,
    "old schema binary preserved",
  );
  assertEqual(
    await readFile(path.join(oldSchemaRoot, "usr/libexec/pi-sandbox/assets/release.txt"), "utf8"),
    "release 1\n",
    "old schema rejects payload swap",
  );

  const occupiedLauncherRoot = path.join(temporaryRoot, "occupied-launcher-root");
  await mkdir(path.join(occupiedLauncherRoot, "usr/bin"), { recursive: true });
  await writeFile(path.join(occupiedLauncherRoot, "usr/bin/pi-sandbox"), "unrelated\n");
  assertRunFails(path.join(release1, "install.sh"), [], { DESTDIR: occupiedLauncherRoot });
  await assertMissing(path.join(occupiedLauncherRoot, "usr/libexec/pi-sandbox"));

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
    'version = 11\ngroup = "admin"\n[overrides.tools.bash]\nmode = "ask"\nsession_grant = "offer"\n';
  await assertMissing(groupsDirectory);
  await mkdir(groupsDirectory, { mode: 0o755 });
  await writeFile(groups, groupContents, { mode: 0o600 });
  const users = path.join(usersDirectory, "1000.toml");
  await writeFile(unrelated, "keep\n");
  await mkdir(usersDirectory, { mode: 0o755 });
  await writeFile(
    users,
    'version = 11\nuid = 1000\n\n[overrides.execution]\nbackend = "direct"\n',
    {
      mode: 0o600,
    },
  );
  run(path.join(release2, "uninstall.sh"), [], { DESTDIR: installRoot });
  await assertMissing(launcher);
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
    'version = 11\nuid = 1000\n\n[overrides.execution]\nbackend = "direct"\n',
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

async function createRelease(
  directory,
  release,
  bundledBubblewrap = false,
  executionBackend = "bubblewrap",
) {
  const payload = path.join(directory, "payload/pi-sandbox");
  await mkdir(path.join(payload, "defaults"), { recursive: true });
  await mkdir(path.join(payload, "theme"));
  await mkdir(path.join(payload, "assets"));
  await mkdir(path.join(payload, "export-html"));
  const layout = bundledBubblewrap
    ? {
        ...defaultLayout,
        bubblewrap: { mode: "bundled", path: "/usr/libexec/pi-sandbox/bwrap" },
      }
    : defaultLayout;
  await writeFile(
    path.join(directory, "install.sh"),
    renderLayoutText(
      await readFile(path.join(repositoryRoot, "scripts/install/install.sh"), "utf8"),
      layout,
      "linux",
    ),
  );
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
case "$operation" in
  --print-build-capabilities) echo '{"configuration_source":"local","architecture":"${process.arch}","platform":"linux"}'; exit 0 ;;
  --validate-installation) ;; *) exit 64 ;; esac
shift
root=
candidate_payload=
while [ "$#" -gt 0 ]; do
  [ "$#" -ge 2 ] || exit 64
  case "$1" in
    --root) root=$2 ;;
    --candidate-payload) [ "$operation" = --validate-installation ] || exit 64; candidate_payload=$2 ;;
    *) exit 64 ;;
  esac
  shift 2
done
config="$root/etc/pi-sandbox/config.toml"
${skillCandidateFixture("/usr/libexec/pi-sandbox")}
grep -q '^config_version = 16$' "$config" || { echo 'config.config_version must be the integer 16' >&2; exit 1; }
grep -q '^# valid = true$' "$config"
models_path=$(awk -F '"' '/^models_file = "/ { print $2; exit }' "$config")
[ -n "$models_path" ]
grep -q '"valid":true' "$root$models_path"
echo ${executionBackend}
`,
    { mode: 0o755 },
  );
  await writeFile(path.join(payload, "package.json"), `${JSON.stringify({ release })}\n`);
  if (bundledBubblewrap) {
    await writeFile(
      path.join(payload, "bwrap"),
      "#!/bin/sh\n[ \"${1:-}\" != --help ] || printf '%s\\n' '--unshare-user --disable-userns --assert-userns-disabled --json-status-fd --seccomp --remount-ro --ro-bind-data'\n",
      { mode: 0o755 },
    );
  }
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
  return `# valid = true\n# release = "${release}"\n${defaultPolicy}`;
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
  return result;
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
