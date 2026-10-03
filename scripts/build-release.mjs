#!/usr/bin/env node

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import { fileURLToPath, URL } from "node:url";
import { spawn } from "node:child_process";
import { parse as parseToml } from "@iarna/toml";

import { loadExtensionManifests } from "./build/extension-composition.mjs";
import { createSbom } from "./build/sbom.mjs";
import { loadDistribution } from "./build/distribution.mjs";
import { renderLayoutText } from "./build/layout-render.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultDistribution = join(repositoryRoot, "config/default/distribution.toml");
const commonRequiredReleaseFiles = Object.freeze([
  "SHA256SUMS",
  "install.sh",
  "uninstall.sh",
  "payload/pi-sandbox/pi-sandbox",
  "payload/pi-sandbox/package.json",
  "payload/pi-sandbox/photon_rs_bg.wasm",
  "payload/pi-sandbox/defaults/config.toml",
  "payload/pi-sandbox/defaults/models.json",
  "payload/pi-sandbox/licenses/LICENSE",
  "payload/pi-sandbox/release-manifest.json",
  "payload/pi-sandbox/sbom.cdx.json",
]);
const commonRequiredReleaseDirectories = Object.freeze([
  "payload/pi-sandbox/assets",
  "payload/pi-sandbox/export-html",
  "payload/pi-sandbox/theme",
]);

function usage(stream = process.stdout) {
  stream.write(`Usage: node scripts/build-release.mjs [options]

Build a pinned, patched Pi Sandbox release for the current host architecture.

Options:
  --pi-source-archive FILE  Use this source archive instead of downloading it
  --out DIRECTORY          Write release output here (default: release)
  --config FILE            Package this default config.toml (default: the
                            platform's Bubblewrap or direct-mode config)
  --models FILE            Package this default models.json
                            (default: config/default/models.json)
  --distribution FILE      Select extensions and installation layout
                            (default: config/default/distribution.toml)
  -h, --help               Show this help

The supplied or downloaded source archive is always checked against
pi-source.lock.json. The build uses a temporary source tree and leaves it out of
the repository.
`);
}

function parseArguments(argv) {
  const options = {
    sourceArchive: undefined,
    out: join(repositoryRoot, "release"),
    config: undefined,
    models: join(repositoryRoot, "config/default/models.json"),
    distribution: defaultDistribution,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help" || argument === "-h") return { help: true };
    if (
      !["--pi-source-archive", "--out", "--config", "--models", "--distribution"].includes(argument)
    ) {
      throw new Error(`unknown option: ${argument}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value`);
    }
    index += 1;
    if (argument === "--pi-source-archive") options.sourceArchive = resolve(value);
    if (argument === "--out") options.out = resolve(value);
    if (argument === "--config") options.config = resolve(value);
    if (argument === "--models") options.models = resolve(value);
    if (argument === "--distribution") options.distribution = resolve(value);
  }
  return options;
}

async function run(command, args, options = {}) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else {
        const detail = signal ? `signal ${signal}` : `exit code ${code}`;
        reject(new Error(`${command} failed with ${detail}`));
      }
    });
  });
}

async function capture(command, args, options = {}) {
  let output;
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: options.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        output = stdout;
        resolvePromise();
      } else {
        const detail = signal ? `signal ${signal}` : `exit code ${code}`;
        reject(new Error(`${command} failed with ${detail}${stderr ? `: ${stderr.trim()}` : ""}`));
      }
    });
  });
  return output;
}

async function sha256(path) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

async function assertRegularFile(path, description) {
  const stats = await lstat(path).catch(() => undefined);
  if (!stats?.isFile()) throw new Error(`${description} must be a regular file: ${path}`);
}

function validateLock(lock) {
  if (
    typeof lock.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(lock.version) ||
    lock.tag !== `v${lock.version}` ||
    typeof lock.commit !== "string" ||
    !/^[0-9a-f]{40}$/.test(lock.commit) ||
    typeof lock.sourceArchive !== "string" ||
    !lock.sourceArchive.startsWith("https://") ||
    typeof lock.sourceArchiveSha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(lock.sourceArchiveSha256)
  ) {
    throw new Error("pi-source.lock.json has an invalid schema");
  }
}

async function download(url, destination) {
  process.stdout.write(`Downloading ${url}\n`);
  const response = await globalThis.fetch(url, {
    headers: { "user-agent": "pi-sandbox-release-builder" },
    redirect: "follow",
  });
  if (!response.ok || response.body === null) {
    throw new Error(`source download failed: HTTP ${response.status}`);
  }
  if (!response.url.startsWith("https://")) {
    throw new Error(`source download redirected to a non-HTTPS URL: ${response.url}`);
  }
  const output = createWriteStream(destination, { flags: "wx", mode: 0o600 });
  Readable.fromWeb(response.body).pipe(output);
  await finished(output);
}

function validateArchiveEntry(entry, expectedRoot) {
  const normalized = entry.replace(/\/$/, "");
  if (
    normalized.length === 0 ||
    normalized.startsWith("/") ||
    normalized.split("/").includes("..") ||
    (normalized !== expectedRoot && !normalized.startsWith(`${expectedRoot}/`))
  ) {
    throw new Error(`source archive contains an unsafe or unexpected path: ${entry}`);
  }
}

async function inspectTree(root) {
  const files = [];
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new Error(`tree contains an unsupported file type: ${path}`);
    }
  }
  await visit(root);
  return files;
}

async function extractSource(archive, temporaryDirectory, lock) {
  const expectedRoot = `pi-${lock.version}`;
  const listing = await capture("tar", ["-tzf", archive]);
  const entries = listing.split("\n").filter(Boolean);
  if (entries.length === 0) throw new Error("source archive is empty");
  for (const entry of entries) validateArchiveEntry(entry, expectedRoot);
  await run("tar", ["-xzf", archive, "-C", temporaryDirectory]);
  const sourceRoot = join(temporaryDirectory, expectedRoot);
  await inspectTree(sourceRoot);
  const packageJson = JSON.parse(
    await readFile(join(sourceRoot, "packages/coding-agent/package.json"), "utf8"),
  );
  if (packageJson.version !== lock.version) {
    throw new Error(`source package version ${packageJson.version} does not match ${lock.version}`);
  }
  return sourceRoot;
}

async function applyPatches(sourceRoot) {
  const patchesDirectory = join(repositoryRoot, "patches/pi");
  const entries = await readdir(patchesDirectory, { withFileTypes: true });
  const patches = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".patch"))
    .map((entry) => join(patchesDirectory, entry.name))
    .sort();
  if (patches.length === 0) throw new Error("no Pi patches were found under patches/pi");
  for (const patch of patches) {
    process.stdout.write(`Applying ${relative(repositoryRoot, patch)}\n`);
    await run("git", ["apply", "--check", patch], { cwd: sourceRoot });
    await run("git", ["apply", patch], { cwd: sourceRoot });
  }
  return Promise.all(
    patches.map(async (patch) => ({ file: basename(patch), sha256: await sha256(patch) })),
  );
}

function hostPlatform() {
  if (process.platform === "linux" && process.arch === "x64")
    return { platform: "linux-x64", bunTarget: "bun-linux-x64-baseline", os: "linux" };
  if (process.platform === "linux" && process.arch === "arm64")
    return { platform: "linux-arm64", bunTarget: "bun-linux-arm64", os: "linux" };
  if (process.platform === "darwin" && process.arch === "arm64")
    return { platform: "darwin-arm64", bunTarget: "bun-darwin-arm64", os: "darwin" };
  if (process.platform === "darwin" && process.arch === "x64")
    return { platform: "darwin-x64", bunTarget: "bun-darwin-x64", os: "darwin" };
  throw new Error(`unsupported release platform: ${process.platform}-${process.arch}`);
}

function releaseRequirements(os, bubblewrap) {
  const nativeHelper = os === "linux" ? "linux-platform-x11.node" : "darwin-platform.node";
  const requiredFiles = [
    ...commonRequiredReleaseFiles,
    `payload/pi-sandbox/native/${os}/prebuilds/${os}-${process.arch}/${nativeHelper}`,
  ];
  if (os === "darwin") {
    return {
      files: requiredFiles,
      directories: commonRequiredReleaseDirectories,
    };
  }
  return {
    files: [
      ...requiredFiles,
      "payload/pi-sandbox/pi-sandbox-identity-broker",
      "payload/pi-sandbox/pi-sandbox-audit-collector",
      "payload/pi-sandbox/systemd/pi-sandbox-audit.socket",
      "payload/pi-sandbox/systemd/pi-sandbox-audit@.service",
      "payload/pi-sandbox/systemd/pi-sandbox-identity-broker.socket",
      "payload/pi-sandbox/systemd/pi-sandbox-identity-broker@.service",
      "payload/pi-sandbox/licenses/identity-broker/THIRD-PARTY-NOTICES.md",
      ...(bubblewrap.mode === "bundled"
        ? ["payload/pi-sandbox/bwrap", "payload/pi-sandbox/licenses/bubblewrap/LICENSE"]
        : []),
    ],
    directories: [
      ...commonRequiredReleaseDirectories,
      "payload/pi-sandbox/licenses/identity-broker",
    ],
  };
}

const REQUIRED_BUBBLEWRAP_OPTIONS = Object.freeze([
  "--unshare-user",
  "--disable-userns",
  "--assert-userns-disabled",
  "--json-status-fd",
  "--seccomp",
]);

async function validateBundledBubblewrap(bubblewrap, architecture) {
  if (bubblewrap.mode !== "bundled") return;
  await assertRegularFile(bubblewrap.binary, "bundled Bubblewrap binary");
  await assertRegularFile(bubblewrap.licenseFile, "bundled Bubblewrap license");
  const actualSha256 = await sha256(bubblewrap.binary);
  if (actualSha256 !== bubblewrap.sha256) {
    throw new Error(
      `bundled Bubblewrap SHA-256 mismatch: expected ${bubblewrap.sha256}, got ${actualSha256}`,
    );
  }
  const binary = await readFile(bubblewrap.binary);
  const expectedMachine = architecture === "x64" ? 62 : architecture === "arm64" ? 183 : undefined;
  if (
    expectedMachine === undefined ||
    binary.byteLength < 20 ||
    binary[0] !== 0x7f ||
    binary.subarray(1, 4).toString("ascii") !== "ELF" ||
    binary[4] !== 2 ||
    binary[5] !== 1 ||
    binary.readUInt16LE(18) !== expectedMachine
  ) {
    throw new Error(`bundled Bubblewrap is not a Linux ${architecture} ELF executable`);
  }
  const version = (await capture(bubblewrap.binary, ["--version"])).trim();
  if (version !== `bubblewrap ${bubblewrap.version}`) {
    throw new Error(
      `bundled Bubblewrap version mismatch: expected bubblewrap ${bubblewrap.version}, got ${version || "no output"}`,
    );
  }
  const help = await capture(bubblewrap.binary, ["--help"]);
  const missingOptions = REQUIRED_BUBBLEWRAP_OPTIONS.filter((option) => !help.includes(option));
  if (missingOptions.length > 0) {
    throw new Error(`bundled Bubblewrap is missing required options: ${missingOptions.join(", ")}`);
  }
}

async function copyPrivateEntrypoint(sourceRoot) {
  const target = join(sourceRoot, "packages/coding-agent/dist/pi-sandbox");
  await mkdir(target, { recursive: true });
  await copyFile(
    join(repositoryRoot, "dist/private/private-cli.js"),
    join(target, "private-cli.js"),
  );
  await copyFile(
    join(repositoryRoot, "scripts/build/private-entrypoint.mjs"),
    join(target, "private-entrypoint.mjs"),
  );
}

async function copyBrokerLicenses(payload) {
  const licensesRoot = join(payload, "licenses");
  const sourceRoot = join(repositoryRoot, "broker/vendor");
  const targetRoot = join(licensesRoot, "identity-broker");
  await mkdir(targetRoot, { recursive: true });
  await copyFile(join(repositoryRoot, "LICENSE"), join(licensesRoot, "LICENSE"));
  await copyFile(
    join(repositoryRoot, "broker/THIRD-PARTY-NOTICES.md"),
    join(targetRoot, "THIRD-PARTY-NOTICES.md"),
  );

  const packages = await readdir(sourceRoot, { withFileTypes: true });
  for (const packageEntry of packages.filter((entry) => entry.isDirectory())) {
    const packageSource = join(sourceRoot, packageEntry.name);
    const licenseFiles = (await readdir(packageSource, { withFileTypes: true })).filter(
      (entry) => entry.isFile() && /^(?:LICENSE|COPYING|UNLICENSE)(?:[-.].*)?$/u.test(entry.name),
    );
    if (licenseFiles.length === 0) {
      throw new Error(`vendored broker package has no license file: ${packageEntry.name}`);
    }
    const packageTarget = join(targetRoot, packageEntry.name);
    await mkdir(packageTarget);
    for (const license of licenseFiles) {
      await copyFile(join(packageSource, license.name), join(packageTarget, license.name));
    }
  }
}

async function renderFile(source, target, layout, os, mode = 0o644) {
  const contents = renderLayoutText(await readFile(source, "utf8"), layout, os);
  await writeFile(target, contents, { mode });
}

async function fileInventory(root) {
  const inventory = [];
  for (const path of await inspectTree(root)) {
    const installedPath = relative(root, path).split(sep).join("/");
    const stats = await lstat(path);
    inventory.push({ path: installedPath, size: stats.size, sha256: await sha256(path) });
  }
  return inventory;
}

async function inspectReleaseArchive(
  archive,
  expectedInventory,
  temporaryDirectory,
  expectedRelease,
  requirements,
) {
  const listing = (await capture("tar", ["-tzf", archive])).split("\n").filter(Boolean);
  for (const entry of listing) validateArchiveEntry(entry, "pi-sandbox");
  const inspectionRoot = join(temporaryDirectory, "archive-inspection");
  await mkdir(inspectionRoot);
  await run("tar", ["-xzf", archive, "-C", inspectionRoot]);
  const extractedRoot = join(inspectionRoot, "pi-sandbox");
  const actualInventory = await fileInventory(extractedRoot);
  if (JSON.stringify(actualInventory) !== JSON.stringify(expectedInventory)) {
    throw new Error("release archive contents do not match the inspected payload");
  }
  for (const path of requirements.files) {
    const stats = await lstat(join(extractedRoot, path)).catch(() => undefined);
    if (stats?.isFile() !== true)
      throw new Error(`release archive is missing required file: ${path}`);
  }
  for (const path of requirements.directories) {
    const stats = await lstat(join(extractedRoot, path)).catch(() => undefined);
    if (stats?.isDirectory() !== true) {
      throw new Error(`release archive is missing required directory: ${path}`);
    }
  }
  const payloadRoot = join(extractedRoot, "payload/pi-sandbox");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(payloadRoot, "release-manifest.json"), "utf8"));
  } catch (cause) {
    throw new Error("release manifest is invalid", { cause });
  }
  const expectedIdentity = {
    manifestVersion: 4,
    product: "pi-sandbox",
    version: expectedRelease.version,
    platform: expectedRelease.platform,
    architecture: expectedRelease.architecture,
    executionBackends: expectedRelease.executionBackends,
    identityBroker: expectedRelease.identityBroker,
    bubblewrap: expectedRelease.bubblewrap,
    pi: expectedRelease.pi,
    extensions: expectedRelease.extensions,
    layout: expectedRelease.layout,
    privateBundleSha256: expectedRelease.privateBundleSha256,
  };
  const actualIdentity = {
    manifestVersion: manifest.manifestVersion,
    product: manifest.product,
    version: manifest.version,
    platform: manifest.platform,
    architecture: manifest.architecture,
    executionBackends: manifest.executionBackends,
    identityBroker: manifest.identityBroker,
    bubblewrap: manifest.bubblewrap,
    pi: manifest.pi,
    extensions: manifest.extensions,
    layout: manifest.layout,
    privateBundleSha256: manifest.privateBundleSha256,
  };
  if (JSON.stringify(actualIdentity) !== JSON.stringify(expectedIdentity)) {
    throw new Error("release manifest identity does not match the requested build");
  }
  const payloadInventory = (await fileInventory(payloadRoot)).filter(
    (entry) => entry.path !== "release-manifest.json",
  );
  if (JSON.stringify(manifest.files) !== JSON.stringify(payloadInventory)) {
    throw new Error("release manifest does not inventory the packaged payload");
  }
  return extractedRoot;
}

async function main() {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    console.error(`build-release: ${error.message}`);
    usage(process.stderr);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    usage();
    return;
  }

  const lockPath = join(repositoryRoot, "pi-source.lock.json");
  const packagePath = join(repositoryRoot, "package.json");
  const lock = JSON.parse(await readFile(lockPath, "utf8"));
  const packageJson = JSON.parse(await readFile(packagePath, "utf8"));
  const target = hostPlatform();
  const distribution = await loadDistribution(options.distribution, target.os);
  options.config ??= join(
    repositoryRoot,
    target.os === "darwin" ? "config/default/config.direct.toml" : "config/default/config.toml",
  );
  validateLock(lock);
  await assertRegularFile(options.config, "default configuration");
  await assertRegularFile(options.models, "default models catalog");
  const packagedConfig = parseToml(await readFile(options.config, "utf8"));
  if (packagedConfig.models_file !== distribution.layout.defaultModelsPath) {
    throw new Error(
      `default configuration models_file must be ${distribution.layout.defaultModelsPath}`,
    );
  }
  const composedExtensions = await loadExtensionManifests(distribution.extensionManifests);
  if (target.os === "linux") {
    await validateBundledBubblewrap(distribution.bubblewrap, process.arch);
  }

  const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-sandbox-release-"));
  try {
    let sourceArchive = options.sourceArchive;
    if (sourceArchive === undefined) {
      sourceArchive = join(temporaryDirectory, basename(new URL(lock.sourceArchive).pathname));
      await download(lock.sourceArchive, sourceArchive);
    } else {
      await assertRegularFile(sourceArchive, "Pi source archive");
    }
    const actualSourceSha256 = await sha256(sourceArchive);
    if (actualSourceSha256 !== lock.sourceArchiveSha256) {
      throw new Error(
        `Pi source archive SHA-256 mismatch: expected ${lock.sourceArchiveSha256}, got ${actualSourceSha256}`,
      );
    }

    const sourceExtraction = join(temporaryDirectory, "source");
    await mkdir(sourceExtraction);
    const sourceRoot = await extractSource(sourceArchive, sourceExtraction, lock);
    const patches = await applyPatches(sourceRoot);
    const { platform, bunTarget, os } = target;
    const cleanEnvironment = { ...process.env };
    delete cleanEnvironment.NODE_ENV;

    process.stdout.write("Bundling the private Pi Sandbox application\n");
    await run(
      process.execPath,
      [join(repositoryRoot, "scripts/build-bundles.mjs"), "--distribution", distribution.path],
      { env: cleanEnvironment },
    );
    let extensionBuildInventory;
    try {
      extensionBuildInventory = JSON.parse(
        await readFile(join(repositoryRoot, "dist/private/extension-build-inventory.json"), "utf8"),
      );
    } catch (cause) {
      throw new Error("compiled extension build inventory is invalid", { cause });
    }
    const expectedExtensions = composedExtensions.map((extension) => ({
      ...extension.metadata,
      manifestSha256: extension.manifestSha256,
      entrypointSha256: extension.entrypointSha256,
    }));
    if (
      extensionBuildInventory.inventoryVersion !== 1 ||
      JSON.stringify(extensionBuildInventory.extensions) !== JSON.stringify(expectedExtensions) ||
      typeof extensionBuildInventory.privateBundleSha256 !== "string" ||
      !/^[0-9a-f]{64}$/.test(extensionBuildInventory.privateBundleSha256)
    ) {
      throw new Error(
        "compiled extension build inventory does not match the requested composition",
      );
    }

    const upstreamOutput = join(temporaryDirectory, "upstream-binaries");
    process.stdout.write(`Building pinned Pi for ${platform} with bundled model data\n`);
    await run(
      "bash",
      [
        "scripts/build-binaries.sh",
        "--offline-model-data",
        "--platform",
        platform,
        "--out",
        upstreamOutput,
      ],
      { cwd: sourceRoot, env: cleanEnvironment },
    );

    process.stdout.write("Testing the managed Pi integration seams\n");
    await run(
      "npm",
      [
        "exec",
        "--",
        "vitest",
        "run",
        "packages/coding-agent/test/auth-check.test.ts",
        "packages/coding-agent/test/managed-model-runtime.test.ts",
        "packages/coding-agent/test/managed-main.test.ts",
        "packages/coding-agent/test/managed-extensions.test.ts",
        "packages/coding-agent/test/managed-session-sharing.test.ts",
      ],
      { cwd: sourceRoot, env: cleanEnvironment },
    );

    await copyPrivateEntrypoint(sourceRoot);
    const stagingDirectory = join(temporaryDirectory, "release-stage");
    const releaseRoot = join(stagingDirectory, "pi-sandbox");
    const payload = join(releaseRoot, "payload/pi-sandbox");
    await mkdir(join(releaseRoot, "payload"), { recursive: true });
    await cp(join(upstreamOutput, platform), payload, { recursive: true, dereference: true });
    await rm(join(payload, "pi"), { force: true });

    const codingAgentRoot = join(sourceRoot, "packages/coding-agent");
    const bunMetafile = join(temporaryDirectory, "bun-metafile.json");
    process.stdout.write("Compiling the private Bun executable\n");
    await run(
      "bun",
      [
        "build",
        "--compile",
        `--metafile=${bunMetafile}`,
        "--no-compile-autoload-bunfig",
        `--target=${bunTarget}`,
        "./dist/pi-sandbox/private-entrypoint.mjs",
        "./src/utils/image-resize-worker.ts",
        "./src/extensions/codemode/worker.ts",
        "--outfile",
        join(payload, "pi-sandbox"),
      ],
      { cwd: codingAgentRoot, env: cleanEnvironment },
    );
    await chmod(join(payload, "pi-sandbox"), 0o755);

    if (os === "linux") {
      process.stdout.write("Compiling the static identity broker\n");
      await run(
        process.execPath,
        [
          join(repositoryRoot, "scripts/build-broker.mjs"),
          join(payload, "pi-sandbox-identity-broker"),
        ],
        { env: cleanEnvironment },
      );
      await run(
        process.execPath,
        [
          join(repositoryRoot, "scripts/build-audit-collector.mjs"),
          join(payload, "pi-sandbox-audit-collector"),
        ],
        { env: cleanEnvironment },
      );
      const systemdTarget = join(payload, "systemd");
      await mkdir(systemdTarget);
      for (const unit of [
        "pi-sandbox-identity-broker.socket",
        "pi-sandbox-identity-broker@.service",
      ]) {
        await renderFile(
          join(repositoryRoot, "packaging/systemd", unit),
          join(systemdTarget, unit),
          distribution.layout,
          os,
        );
      }
      for (const unit of ["pi-sandbox-audit.socket", "pi-sandbox-audit@.service"]) {
        await renderFile(
          join(repositoryRoot, "packaging/systemd", unit),
          join(systemdTarget, unit),
          distribution.layout,
          os,
        );
      }
      await copyBrokerLicenses(payload);
      if (distribution.bubblewrap.mode === "bundled") {
        await copyFile(distribution.bubblewrap.binary, join(payload, "bwrap"));
        await chmod(join(payload, "bwrap"), 0o755);
        const bubblewrapLicenses = join(payload, "licenses/bubblewrap");
        await mkdir(bubblewrapLicenses);
        await copyFile(distribution.bubblewrap.licenseFile, join(bubblewrapLicenses, "LICENSE"));
      }
    } else {
      await mkdir(join(payload, "licenses"), { recursive: true });
      await copyFile(join(repositoryRoot, "LICENSE"), join(payload, "licenses/LICENSE"));
    }

    const defaults = join(payload, "defaults");
    await mkdir(defaults);
    await copyFile(options.config, join(defaults, "config.toml"));
    await copyFile(options.models, join(defaults, "models.json"));

    const validationRoot = join(temporaryDirectory, "candidate-validation");
    const validationConfigDirectory = join(validationRoot, distribution.layout.configDir.slice(1));
    await mkdir(validationConfigDirectory, { recursive: true });
    await copyFile(options.config, join(validationConfigDirectory, "config.toml"));
    await copyFile(options.models, join(validationConfigDirectory, "models.json"));
    process.stdout.write("Validating the compiled executable and packaged defaults\n");
    await run(join(payload, "pi-sandbox"), ["--validate-installation", "--root", validationRoot], {
      env: cleanEnvironment,
    });

    for (const [name, source] of [
      [
        "install.sh",
        os === "linux" ? "scripts/install/install.sh" : "scripts/install/macos-install.sh",
      ],
      [
        "uninstall.sh",
        os === "linux" ? "scripts/install/uninstall.sh" : "scripts/install/macos-uninstall.sh",
      ],
    ]) {
      await renderFile(
        join(repositoryRoot, source),
        join(releaseRoot, name),
        distribution.layout,
        os,
        0o755,
      );
    }

    const sbom = await createSbom({
      repositoryRoot,
      sourceRoot,
      codingAgentRoot,
      bunMetafile,
      packageJson,
      lock,
      patches,
      extensions: extensionBuildInventory.extensions,
      platform,
      bunVersion: (await capture("bun", ["--version"])).trim(),
      sourceCommit: (await capture("git", ["rev-parse", "HEAD"])).trim(),
      sourceDirty: (await capture("git", ["status", "--porcelain"])).trim().length > 0,
      bubblewrap: os === "linux" ? distribution.bubblewrap.release : null,
      payload,
    });
    await writeFile(join(payload, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`, {
      mode: 0o644,
    });

    const releaseManifestPath = join(payload, "release-manifest.json");
    const releaseManifest = {
      manifestVersion: 4,
      product: "pi-sandbox",
      version: packageJson.version,
      platform,
      architecture: process.arch,
      executionBackends: os === "linux" ? ["bubblewrap", "direct"] : ["direct"],
      identityBroker: os === "linux",
      bubblewrap: os === "linux" ? distribution.bubblewrap.release : null,
      pi: {
        version: lock.version,
        tag: lock.tag,
        commit: lock.commit,
        sourceArchive: lock.sourceArchive,
        sourceArchiveSha256: lock.sourceArchiveSha256,
      },
      extensions: extensionBuildInventory.extensions,
      layout: distribution.layout,
      privateBundleSha256: extensionBuildInventory.privateBundleSha256,
      patches,
      files: await fileInventory(payload),
    };
    await writeFile(releaseManifestPath, `${JSON.stringify(releaseManifest, null, 2)}\n`, {
      mode: 0o644,
    });

    const checksumEntries = await fileInventory(payload);
    await writeFile(
      join(releaseRoot, "SHA256SUMS"),
      `${checksumEntries
        .map((entry) => `${entry.sha256}  payload/pi-sandbox/${entry.path}`)
        .join("\n")}\n`,
      { mode: 0o644 },
    );
    const expectedInventory = await fileInventory(releaseRoot);

    await mkdir(options.out, { recursive: true });
    const archiveName = `pi-sandbox-${packageJson.version}-${platform}.tar.gz`;
    const archive = join(options.out, archiveName);
    const archiveTar = os === "darwin" ? "gtar" : "tar";
    await run(archiveTar, [
      "--sort=name",
      "--mtime=@0",
      "--owner=0",
      "--group=0",
      "--numeric-owner",
      "-czf",
      archive,
      "-C",
      stagingDirectory,
      "pi-sandbox",
    ]);
    const extractedRelease = await inspectReleaseArchive(
      archive,
      expectedInventory,
      temporaryDirectory,
      {
        version: packageJson.version,
        platform,
        architecture: process.arch,
        executionBackends: os === "linux" ? ["bubblewrap", "direct"] : ["direct"],
        identityBroker: os === "linux",
        bubblewrap: os === "linux" ? distribution.bubblewrap.release : null,
        pi: {
          version: lock.version,
          tag: lock.tag,
          commit: lock.commit,
          sourceArchive: lock.sourceArchive,
          sourceArchiveSha256: lock.sourceArchiveSha256,
        },
        extensions: extensionBuildInventory.extensions,
        layout: distribution.layout,
        privateBundleSha256: extensionBuildInventory.privateBundleSha256,
      },
      releaseRequirements(os, distribution.bubblewrap),
    );
    if (os === "linux") {
      process.stdout.write("Testing /sandbox through the packaged executable\n");
      await run(
        process.execPath,
        [
          join(repositoryRoot, "scripts/test/packaged-diagnostics-smoke.mjs"),
          join(extractedRelease, "payload/pi-sandbox/pi-sandbox"),
          join(extractedRelease, "payload/pi-sandbox/defaults"),
        ],
        { env: cleanEnvironment },
      );
    }
    const archiveSha256 = await sha256(archive);
    await writeFile(join(options.out, "SHA256SUMS"), `${archiveSha256}  ${archiveName}\n`, {
      mode: 0o644,
    });
    process.stdout.write(`Created and inspected ${archive}\nSHA-256 ${archiveSha256}\n`);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(`build-release: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
