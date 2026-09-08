#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const collectorRoot = join(repositoryRoot, "audit-collector");
const targetDirectory = join(collectorRoot, "target");
const output = resolve(
  process.argv[2] ?? join(repositoryRoot, "dist/native/pi-sandbox-audit-collector"),
);
const target =
  process.arch === "x64"
    ? "x86_64-unknown-linux-gnu"
    : process.arch === "arm64"
      ? "aarch64-unknown-linux-gnu"
      : undefined;

if (process.platform !== "linux" || target === undefined) {
  throw new Error(
    `audit collector builds require Linux x64 or arm64; found ${process.platform}-${process.arch}`,
  );
}

const cargo = await findCargo();
const environment = { ...process.env };
delete environment.NODE_ENV;
delete environment.RUSTFLAGS;
delete environment.CARGO_ENCODED_RUSTFLAGS;
environment.CARGO_ENCODED_RUSTFLAGS = [
  "-Ctarget-feature=+crt-static",
  `--remap-path-prefix=${repositoryRoot}=/usr/src/pi-sandbox`,
  `--remap-path-prefix=${homedir()}=/usr/src/build-home`,
].join("\u001f");

await run(cargo, [
  "build",
  "--manifest-path",
  join(collectorRoot, "Cargo.toml"),
  "--target-dir",
  targetDirectory,
  "--release",
  "--locked",
  "--offline",
  "--target",
  target,
]);

const built = join(targetDirectory, target, "release/pi-sandbox-audit-collector");
await mkdir(dirname(output), { recursive: true });
await copyFile(built, output);
await chmod(output, 0o755);
await assertStaticExecutable(output);
await assertNoBuildPaths(output);

async function findCargo() {
  const candidates = [process.env.CARGO, join(homedir(), ".cargo/bin/cargo"), "cargo"].filter(
    (candidate) => candidate !== undefined,
  );
  for (const candidate of candidates) {
    if (candidate === "cargo") return candidate;
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error("cargo is required to build the audit collector");
}

async function assertStaticExecutable(path) {
  let outputText = "";
  await run("file", [path], (chunk) => {
    outputText += chunk;
  });
  if (!outputText.includes("statically linked") && !outputText.includes("static-pie linked")) {
    throw new Error(`audit collector is not statically linked: ${outputText.trim()}`);
  }
}

async function assertNoBuildPaths(path) {
  let outputText = "";
  await run("strings", [path], (chunk) => {
    outputText += chunk;
  });
  for (const forbidden of [repositoryRoot, homedir()]) {
    if (outputText.includes(forbidden)) {
      throw new Error(`audit collector contains a build-host path: ${forbidden}`);
    }
  }
}

function run(command, args, onStdout) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: collectorRoot,
      env: environment,
      stdio: ["ignore", onStdout === undefined ? "inherit" : "pipe", "inherit"],
    });
    child.stdout?.on("data", onStdout);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed with ${signal ?? `exit code ${code}`}`));
    });
  });
}
