#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const collectorRoot = join(repositoryRoot, "audit-collector");
const manifest = join(collectorRoot, "Cargo.toml");
const cargo = await findCargo();
const environment = { ...process.env };
delete environment.NODE_ENV;

for (const args of [
  ["fmt", "--manifest-path", manifest, "--check"],
  ["clippy", "--manifest-path", manifest, "--locked", "--offline", "--", "-D", "warnings"],
  ["test", "--manifest-path", manifest, "--locked", "--offline"],
]) {
  await run(cargo, args);
}

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
  throw new Error("cargo is required to test the audit collector");
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: collectorRoot,
      env: environment,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed with ${signal ?? `exit code ${code}`}`));
    });
  });
}
