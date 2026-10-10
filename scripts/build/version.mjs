import { execFileSync } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { join } from "node:path";

/** Build identity is captured once, never inferred from the installed runtime's CWD. */
export async function readBuildVersion(repositoryRoot) {
  const product = JSON.parse(await readFile(join(repositoryRoot, "package.json"), "utf8"));
  const pi = JSON.parse(await readFile(join(repositoryRoot, "pi-source.lock.json"), "utf8"));
  const releaseVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
  if (!releaseVersion.test(product.version) || !releaseVersion.test(pi.version)) {
    throw new Error("Pi and Pi Sandbox versions must be release SemVer numbers");
  }
  const base = `${pi.version}+ps.${product.version}`;
  const git = (...args) =>
    execFileSync("git", ["-C", repositoryRoot, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  let gitRoot;
  try {
    gitRoot = git("rev-parse", "--show-toplevel");
  } catch {
    // Unpacked source has no Git identity and is explicitly a development build.
    return {
      productVersion: product.version,
      piVersion: pi.version,
      displayVersion: `${base}.dev.source`,
      sourceCommit: null,
      sourceDirty: null,
      releaseTag: null,
    };
  }
  if ((await realpath(gitRoot)) !== (await realpath(repositoryRoot))) {
    throw new Error("build version must be read from the repository root");
  }
  const sourceCommit = git("rev-parse", "HEAD");
  const sourceDirty = git("status", "--porcelain").length > 0;
  const expectedTag = `v${product.version}`;
  const releaseTag =
    !sourceDirty && git("tag", "--points-at", "HEAD").split("\n").includes(expectedTag)
      ? expectedTag
      : null;
  return {
    productVersion: product.version,
    piVersion: pi.version,
    sourceCommit,
    sourceDirty,
    releaseTag,
    displayVersion:
      releaseTag === null
        ? `${base}.dev.g${sourceCommit.slice(0, 7)}${sourceDirty ? ".dirty" : ""}`
        : base,
  };
}
