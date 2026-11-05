import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  copySkillsBundle,
  loadSkillsBundle,
  validatePackagedSkills,
  validateSkillsConfiguration,
} from "../build/skills.mjs";

async function fixture(run) {
  const root = await mkdtemp(join(tmpdir(), "pi-skills-build-"));
  try {
    const source = join(root, "source");
    const payload = join(root, "payload");
    await mkdir(source);
    await mkdir(payload);
    await run({ root, source, payload });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("bundles a complete tree with normalized modes and content provenance", async () => {
  await fixture(async ({ root, source, payload }) => {
    await mkdir(join(source, "review/scripts"), { recursive: true, mode: 0o700 });
    await mkdir(join(source, "empty"));
    await writeFile(join(source, "review/SKILL.md"), "---\nname: review\n---\nReview.\n");
    await writeFile(join(source, "review/LICENSE"), "license\n");
    await writeFile(join(source, "review/scripts/check.sh"), "#!/bin/sh\necho checked\n");
    await chmod(join(source, "review/scripts/check.sh"), 0o710);
    const bundle = await loadSkillsBundle(source);
    assert.equal(bundle.release.source.kind, "prepared-directory");
    assert.match(bundle.release.source.sha256, /^[0-9a-f]{64}$/u);
    assert.ok(!JSON.stringify(bundle.release).includes(root));
    await copySkillsBundle(bundle, payload);
    assert.deepEqual(bundle.release.directories, [
      "skills",
      "skills/empty",
      "skills/review",
      "skills/review/scripts",
    ]);
    assert.equal((await lstat(join(payload, "skills/review/scripts"))).mode & 0o7777, 0o755);
    assert.equal(
      (await lstat(join(payload, "skills/review/scripts/check.sh"))).mode & 0o7777,
      0o755,
    );
    assert.equal((await lstat(join(payload, "skills/review/LICENSE"))).mode & 0o7777, 0o644);
    assert.equal(
      await readFile(join(payload, "skills-modes.txt"), "utf8"),
      "0644 skills/review/LICENSE\n0644 skills/review/SKILL.md\n0755 skills/review/scripts/check.sh\n",
    );
    await validatePackagedSkills(payload, bundle.release);
    await chmod(join(payload, "skills/review/scripts/check.sh"), 0o644);
    await assert.rejects(
      validatePackagedSkills(payload, bundle.release),
      /mode inventory|complete bundled skill inventory/u,
    );
  });
});

test("empty selected bundles remain distinguishable from unselected bundles", async () => {
  await fixture(async ({ source, payload }) => {
    assert.equal(await loadSkillsBundle(undefined), undefined);
    await copySkillsBundle(undefined, payload);
    await validatePackagedSkills(payload);
    const bundle = await loadSkillsBundle(source);
    await copySkillsBundle(bundle, payload);
    assert.equal(await readFile(join(payload, "skills-modes.txt"), "utf8"), "");
    await validatePackagedSkills(payload, bundle.release);
    await assert.rejects(validatePackagedSkills(payload), /unselected/u);
    await rm(join(payload, "skills-modes.txt"));
    await assert.rejects(validatePackagedSkills(payload, bundle.release), /require both/u);
    await writeFile(join(payload, "skills-modes.txt"), "");
    await rm(join(payload, "skills"), { recursive: true });
    await assert.rejects(validatePackagedSkills(payload, bundle.release), /require both/u);
  });
});

for (const name of [
  "white space",
  "tab\tfile",
  "line\nfile",
  "back\\slash",
  "control\x01",
  "caf\u00e9",
  "nonbreaking\u00a0space",
]) {
  test(`rejects nonportable bundled filename ${JSON.stringify(name)}`, async () => {
    await fixture(async ({ source }) => {
      await writeFile(join(source, name), "content");
      await assert.rejects(loadSkillsBundle(source), /printable ASCII/u);
    });
  });
}

test("rejects symlink and special-file inputs", async () => {
  await fixture(async ({ root, source }) => {
    const target = join(root, "target");
    await writeFile(target, "external");
    await symlink(target, join(source, "linked"));
    await assert.rejects(loadSkillsBundle(source), /unsupported file type/u);
    await rm(join(source, "linked"));
    assert.equal(spawnSync("mkfifo", [join(source, "pipe")]).status, 0);
    await assert.rejects(loadSkillsBundle(source), /unsupported file type/u);
    await assert.rejects(loadSkillsBundle(target), /regular directory/u);
  });
});

test("detects source changes between admission and copy", async () => {
  await fixture(async ({ source, payload }) => {
    await writeFile(join(source, "SKILL.md"), "original");
    const bundle = await loadSkillsBundle(source);
    await writeFile(join(source, "SKILL.md"), "replacement");
    await assert.rejects(copySkillsBundle(bundle, payload), /changed during the build/u);
  });
  await fixture(async ({ source, payload }) => {
    const bundle = await loadSkillsBundle(source);
    await mkdir(join(source, "late"));
    await assert.rejects(copySkillsBundle(bundle, payload), /changed during the build/u);
  });
});

test("checks selected/default configuration in both directions and configured subdirectories", async () => {
  await fixture(async ({ source }) => {
    await mkdir(join(source, "team"));
    const bundle = await loadSkillsBundle(source);
    const layout = { libexecDir: "/opt/example/libexec" };
    const config = (directories) => ({ skills: { directories } });
    validateSkillsConfiguration(undefined, {}, layout);
    validateSkillsConfiguration(undefined, config(["/external/not-yet-deployed"]), layout);
    assert.throws(() => validateSkillsConfiguration(bundle, {}, layout), /must include/u);
    assert.throws(
      () => validateSkillsConfiguration(undefined, config(["/opt/example/libexec/skills"]), layout),
      /absent/u,
    );
    validateSkillsConfiguration(
      bundle,
      config(["/opt/example/libexec/skills", "/opt/example/libexec/skills/team"]),
      layout,
    );
    assert.throws(
      () =>
        validateSkillsConfiguration(
          bundle,
          config(["/opt/example/libexec/skills", "/opt/example/libexec/skills/missing"]),
          layout,
        ),
      /absent/u,
    );
  });
});

test("checks complete sidecar and archive inventory rather than bytes alone", async () => {
  for (const mutation of [
    "extra-file",
    "changed-bytes",
    "changed-mode",
    "sidecar",
    "directory-mode",
  ]) {
    await fixture(async ({ source, payload }) => {
      await writeFile(join(source, "SKILL.md"), "skill");
      const bundle = await loadSkillsBundle(source);
      await copySkillsBundle(bundle, payload);
      if (mutation === "extra-file") await writeFile(join(payload, "skills/unlisted"), "extra");
      if (mutation === "changed-bytes")
        await writeFile(join(payload, "skills/SKILL.md"), "different");
      if (mutation === "changed-mode") await chmod(join(payload, "skills/SKILL.md"), 0o600);
      if (mutation === "sidecar")
        await writeFile(join(payload, "skills-modes.txt"), "0755 skills/SKILL.md\n");
      if (mutation === "directory-mode") await chmod(join(payload, "skills"), 0o700);
      await assert.rejects(validatePackagedSkills(payload, bundle.release), /inventory|mode/u);
    });
  }
});
