import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { readBuildVersion } from "../build/version.mjs";

test("build identity distinguishes source, commits, matching tags, and dirty trees", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-version-"));
  const git = (...args) =>
    execFileSync("git", ["-C", root, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  try {
    await writeFile(join(root, "package.json"), '{"version":"0.6.0"}\n');
    await writeFile(join(root, "pi-source.lock.json"), '{"version":"1.1.0"}\n');
    assert.equal((await readBuildVersion(root)).displayVersion, "1.1.0+ps.0.6.0.dev.source");
    git("init");
    git("add", ".");
    git(
      "-c",
      "user.name=Version fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-m",
      "Fixture",
    );
    const commit = git("rev-parse", "HEAD");
    const dev = `1.1.0+ps.0.6.0.dev.g${commit.slice(0, 7)}`;
    assert.equal((await readBuildVersion(root)).displayVersion, dev);
    git("tag", "v0.5.0");
    assert.equal((await readBuildVersion(root)).displayVersion, dev);
    git("tag", "v0.6.0");
    assert.deepEqual(await readBuildVersion(root), {
      productVersion: "0.6.0",
      piVersion: "1.1.0",
      sourceCommit: commit,
      sourceDirty: false,
      releaseTag: "v0.6.0",
      displayVersion: "1.1.0+ps.0.6.0",
    });
    await writeFile(join(root, "untracked"), "fixture");
    assert.equal((await readBuildVersion(root)).displayVersion, `${dev}.dirty`);
    await rm(join(root, "untracked"));
    const original = await readFile(join(root, "package.json"), "utf8");
    await writeFile(join(root, "package.json"), `${original}\n`);
    assert.equal((await readBuildVersion(root)).displayVersion, `${dev}.dirty`);
    await writeFile(join(root, "package.json"), '{"version":"0.6.0+custom"}');
    await assert.rejects(readBuildVersion(root), /release SemVer/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
