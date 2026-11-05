import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

import { copySkillsBundle, loadSkillsBundle } from "../build/skills.mjs";

/** Small installer fixture contract; actual TOML/candidate semantics are tested in runtime tests. */
export function skillCandidateFixture(installedDirectory) {
  return `
if [ "$operation" = --validate-installation ]; then
  [ -n "$candidate_payload" ] || { echo 'missing candidate payload' >&2; exit 64; }
  expected_payload=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
  [ "$candidate_payload" = "$expected_payload" ] || { echo 'wrong candidate payload' >&2; exit 64; }
  installed_skills='${installedDirectory.replaceAll("'", "'\\''")}/skills'
  skills_root=$(sed -n 's/^directories = \\["\\([^"]*\\)"\\]$/\\1/p' "$config")
  case "$skills_root" in
    "$installed_skills"|"$installed_skills/"*)
      suffix=\${skills_root#"$installed_skills"}
      [ -d "$candidate_payload/skills$suffix" ] || {
        echo 'configured bundled skill directory is absent from the candidate' >&2; exit 1;
      }
      ;;
  esac
fi
`;
}

export async function writeReleaseChecksums(directory) {
  const payload = join(directory, "payload/pi-sandbox");
  const entries = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file);
      else if (entry.isFile()) {
        const hash = createHash("sha256")
          .update(await readFile(file))
          .digest("hex");
        entries.push(`${hash}  payload/pi-sandbox/${relative(payload, file)}`);
      } else throw new Error(`unexpected fixture entry: ${file}`);
    }
  }
  await visit(payload);
  await writeFile(join(directory, "SHA256SUMS"), `${entries.sort().join("\n")}\n`);
}

/** Exercise the same packaging contracts through each real platform installer. */
export async function verifySkillInstallation({ root, createRelease, libexecDir }) {
  await mkdir(root, { recursive: true });
  const installedRoot = join(root, "installed");
  const installBase = join(installedRoot, libexecDir.slice(1));
  const config = join(installedRoot, "etc/pi-sandbox/config.toml");
  let serial = 0;
  async function release({ empty = false, bundled = true, generation = "first" } = {}) {
    const directory = join(root, `release-${serial++}`);
    await createRelease(directory);
    const payload = join(directory, "payload/pi-sandbox");
    if (bundled) {
      const source = join(root, `source-${serial}`);
      await mkdir(source);
      if (!empty) {
        await mkdir(join(source, "team/scripts"), { recursive: true });
        await writeFile(join(source, "team/SKILL.md"), `---\nname: shared\n---\n${generation}\n`);
        await writeFile(join(source, "team/scripts/run.sh"), "#!/bin/sh\necho shared\n", {
          mode: 0o711,
        });
        await writeFile(join(source, "team/LICENSE"), "skill license\n");
        await writeFile(join(source, `${generation}.txt`), generation);
      }
      await copySkillsBundle(await loadSkillsBundle(source), payload);
      await writeFile(
        join(payload, "defaults/config.toml"),
        `${await readFile(join(payload, "defaults/config.toml"), "utf8")}\n[skills]\ndirectories = ["${libexecDir}/skills"]\n`,
      );
      // Installer must restore declared modes; archive execute bits are not authoritative.
      if (!empty) {
        await chmod(join(payload, "skills/team/scripts/run.sh"), 0o644);
        await chmod(join(payload, "skills/team/SKILL.md"), 0o755);
      }
    }
    await writeReleaseChecksums(directory);
    return directory;
  }
  function install(
    directory,
    { replace = false, target = installedRoot, expectedError, environment = {} } = {},
  ) {
    const result = spawnSync(join(directory, "install.sh"), replace ? ["--replace-config"] : [], {
      encoding: "utf8",
      env: { ...process.env, ...environment, DESTDIR: target },
    });
    if (result.error) throw result.error;
    if (expectedError) {
      assert.notEqual(result.status, 0, "invalid skill release unexpectedly installed");
      assert.match(`${result.stdout}${result.stderr}`, expectedError);
    } else assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  }
  const first = await release();
  install(first);
  assert.equal((await lstat(join(installBase, "skills/team/scripts/run.sh"))).mode & 0o7777, 0o755);
  assert.equal((await lstat(join(installBase, "skills/team/SKILL.md"))).mode & 0o7777, 0o644);
  assert.equal(await readFile(join(installBase, "skills/team/LICENSE"), "utf8"), "skill license\n");
  const retainedConfig = `${await readFile(config, "utf8")}# retained operator setting\n`;
  await writeFile(config, retainedConfig);
  const second = await release({ generation: "second" });
  install(second);
  assert.equal(await readFile(config, "utf8"), retainedConfig);
  await assert.rejects(lstat(join(installBase, "skills/first.txt")), { code: "ENOENT" });
  assert.equal(await readFile(join(installBase, "skills/second.txt"), "utf8"), "second");

  // Fail a configuration rename after payload replacement to exercise real rollback.
  const failedUpgrade = await release({ generation: "failed" });
  const fakeBin = join(root, "rollback-bin");
  await mkdir(fakeBin);
  await writeFile(
    join(fakeBin, "mv"),
    `#!/bin/sh\nfor target do :; done\nif [ "$target" = '${config.replaceAll("'", "'\\''")}' ]; then\n  echo 'injected skill rollback failure' >&2\n  exit 73\nfi\nexec /bin/mv "$@"\n`,
    { mode: 0o755 },
  );
  install(failedUpgrade, {
    replace: true,
    environment: { PATH: `${fakeBin}:${process.env.PATH}` },
    expectedError: /injected skill rollback failure/u,
  });
  assert.equal(await readFile(config, "utf8"), retainedConfig);
  assert.equal(await readFile(join(installBase, "skills/second.txt"), "utf8"), "second");
  assert.equal((await lstat(join(installBase, "skills/team/scripts/run.sh"))).mode & 0o7777, 0o755);
  await assert.rejects(lstat(join(installBase, "skills/failed.txt")), { code: "ENOENT" });

  const noBundle = await release({ bundled: false });
  install(noBundle, { expectedError: /configured bundled skill directory is absent/u });
  assert.equal(await readFile(config, "utf8"), retainedConfig);
  assert.equal(await readFile(join(installBase, "skills/second.txt"), "utf8"), "second");
  await writeFile(
    config,
    retainedConfig.replace(`${libexecDir}/skills"`, `${libexecDir}/skills/team"`),
  );
  const empty = await release({ empty: true });
  install(empty, { expectedError: /configured bundled skill directory is absent/u });
  assert.equal(await readFile(join(installBase, "skills/second.txt"), "utf8"), "second");
  install(empty, { replace: true });
  assert.equal(await readFile(join(installBase, "skills-modes.txt"), "utf8"), "");
  assert.ok((await lstat(join(installBase, "skills"))).isDirectory());
  install(noBundle, { replace: true });
  await assert.rejects(lstat(join(installBase, "skills")), { code: "ENOENT" });
  await assert.rejects(lstat(join(installBase, "skills-modes.txt")), { code: "ENOENT" });

  // External roots may be absent at installation and are never package-owned.
  const external = join(root, "external-skills");
  await mkdir(external);
  await writeFile(join(external, "SKILL.md"), "external");
  await writeFile(
    config,
    `${await readFile(config, "utf8")}\n[skills]\ndirectories = ["${external}"]\n`,
  );
  install(noBundle);
  const result = spawnSync(join(noBundle, "uninstall.sh"), [], {
    encoding: "utf8",
    env: { ...process.env, DESTDIR: installedRoot },
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.equal(await readFile(join(external, "SKILL.md"), "utf8"), "external");
  await writeFile(
    config,
    (await readFile(config, "utf8")).replace(external, `${external}/not-deployed`),
  );
  install(noBundle);

  for (const corruption of [
    "unknown-mode",
    "duplicate",
    "unsorted",
    "absolute",
    "dot",
    "traversal",
    "double-slash",
    "whitespace",
    "backslash",
    "non-ascii",
    "missing-file",
    "unlisted-file",
    "no-final-newline",
    "missing-sidecar",
    "missing-tree",
    "bad-directory",
    "newline-directory",
    "control-directory",
    "bad-checksum",
    "duplicate-checksum",
  ]) {
    const corrupt = await release();
    const payload = join(corrupt, "payload/pi-sandbox");
    const modesPath = join(payload, "skills-modes.txt");
    let modes = await readFile(modesPath, "utf8");
    if (corruption === "unknown-mode") modes = modes.replace("0644", "4755");
    if (corruption === "duplicate") modes += modes.split("\n")[0] + "\n";
    if (corruption === "unsorted") modes = modes.trimEnd().split("\n").reverse().join("\n") + "\n";
    if (corruption === "absolute") modes = modes.replace("skills/", "/skills/");
    if (corruption === "dot") modes = modes.replace("skills/", "skills/./");
    if (corruption === "traversal") modes = modes.replace("skills/", "skills/../");
    if (corruption === "double-slash") modes = modes.replace("skills/", "skills//");
    if (corruption === "whitespace") modes = modes.replace("first.txt", "first file.txt");
    if (corruption === "backslash") modes = modes.replace("first.txt", "first\\file.txt");
    if (corruption === "non-ascii") modes = modes.replace("first.txt", "caf\u00e9.txt");
    if (corruption === "missing-file") modes = modes.replace("first.txt", "absent.txt");
    if (corruption === "unlisted-file")
      await writeFile(join(payload, "skills/unlisted"), "unlisted");
    if (corruption === "no-final-newline") modes = modes.trimEnd();
    if (corruption === "bad-directory") await mkdir(join(payload, "skills/bad directory"));
    if (corruption === "newline-directory") await mkdir(join(payload, "skills/line\nother"));
    if (corruption === "control-directory") await mkdir(join(payload, "skills/control\x01"));
    await writeFile(modesPath, modes);
    if (corruption === "missing-sidecar") await rm(modesPath);
    if (corruption === "missing-tree") await rm(join(payload, "skills"), { recursive: true });
    await writeReleaseChecksums(corrupt);
    if (corruption === "bad-checksum") await writeFile(modesPath, modes + "corrupted\n");
    if (corruption === "duplicate-checksum") {
      const checksumPath = join(corrupt, "SHA256SUMS");
      const entries = (await readFile(checksumPath, "utf8")).trimEnd().split("\n");
      entries[1] = entries[0];
      await writeFile(checksumPath, entries.join("\n") + "\n");
    }
    install(corrupt, { expectedError: /skill|checksum|SHA256SUMS/u });
    // Every rejection occurs before the installed payload/config are replaced.
    await assert.rejects(lstat(join(installBase, "skills")), { code: "ENOENT" });
    assert.ok((await readFile(config, "utf8")).includes("not-deployed"));
  }
}
