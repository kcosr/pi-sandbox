import { execFileSync } from "node:child_process";
import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";

import { loadExtensionManifests } from "./extension-composition.mjs";

export function releaseArguments(argv, environment) {
  return {
    requireSmolvm:
      argv.includes("--require-smolvm") || environment.PI_SANDBOX_REQUIRE_SMOLVM === "1",
    buildArguments: argv.filter((argument) => argument !== "--require-smolvm"),
  };
}

/** Validate the release lane before any build or native test starts. */
export function validateSmolvmReleaseInputs(environment, distribution, extensions, platform, arch) {
  if (platform !== "linux" || arch !== "x64")
    throw new Error("The required smolvm release lane needs Linux x86-64 with KVM");
  for (const name of [
    "PI_SANDBOX_SMOLVM_BIN",
    "PI_SANDBOX_SMOLVM_IMAGE",
    "PI_SANDBOX_SMOLVM_OCI_IMAGE",
  ]) {
    const value = environment[name];
    if (
      typeof value !== "string" ||
      !isAbsolute(value) ||
      normalize(value) !== value ||
      /[\0\r\n]/u.test(value)
    )
      throw new Error(`${name} must name a normalized absolute file path`);
  }
  for (const name of ["PI_SANDBOX_SMOLVM_IMAGE_SHA256", "PI_SANDBOX_SMOLVM_OCI_SHA256"])
    if (!/^[0-9a-f]{64}$/u.test(environment[name] ?? ""))
      throw new Error(`${name} must contain the image's lowercase SHA-256 digest`);
  if (
    !distribution.layout.allowConfigOverride ||
    distribution.smolvm?.path !== environment.PI_SANDBOX_SMOLVM_BIN
  )
    throw new Error(
      "The required smolvm release lane needs a review distribution with " +
        "allow_config_override = true and smolvm.path matching PI_SANDBOX_SMOLVM_BIN",
    );
  if (
    !extensions.some(
      ({ metadata }) =>
        metadata.kind === "managed" &&
        metadata.id === "git" &&
        metadata.tools.includes("git_clone"),
    )
  )
    throw new Error("The required smolvm release lane needs the managed Git extension");
}

export async function preflightSmolvmRelease(buildArguments, environment) {
  const distributionIndex = buildArguments.lastIndexOf("--distribution");
  const distributionPath = buildArguments[distributionIndex + 1];
  if (distributionIndex < 0 || !distributionPath || distributionPath.startsWith("--"))
    throw new Error("The required smolvm release lane needs --distribution REVIEW_MANIFEST");
  const { loadDistribution } = await import("./distribution.mjs");
  const distribution = await loadDistribution(distributionPath);
  const extensions = await loadExtensionManifests(distribution.extensionManifests);
  validateSmolvmReleaseInputs(
    environment,
    distribution,
    extensions,
    process.platform,
    process.arch,
  );
  for (const name of [
    "PI_SANDBOX_SMOLVM_BIN",
    "PI_SANDBOX_SMOLVM_IMAGE",
    "PI_SANDBOX_SMOLVM_OCI_IMAGE",
  ]) {
    if (!(await stat(environment[name])).isFile()) throw new Error(`${name} must name a file`);
    await access(
      environment[name],
      name === "PI_SANDBOX_SMOLVM_BIN" ? constants.R_OK | constants.X_OK : constants.R_OK,
    );
  }
  await access("/dev/kvm", constants.R_OK | constants.W_OK);
  // Package acceptance uses PATH's Bun; the PTY fixture may select another one.
  for (const executable of new Set(["bun", environment.PI_SANDBOX_TEST_BUN].filter(Boolean))) {
    const version = execFileSync(executable, ["--version"], {
      env: environment,
      encoding: "utf8",
      timeout: 10000,
    }).trim();
    const match = /^(\d+)\.(\d+)\.(\d+)$/u.exec(version);
    if (
      !match ||
      Number(match[1]) < 1 ||
      (Number(match[1]) === 1 &&
        (Number(match[2]) < 3 || (Number(match[2]) === 3 && Number(match[3]) < 14)))
    )
      throw new Error("The required smolvm release lane needs Bun 1.3.14 or newer");
  }
}
