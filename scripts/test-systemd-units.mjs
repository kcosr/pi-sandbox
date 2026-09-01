#!/usr/bin/env node

import { spawn } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root = await mkdtemp(join(tmpdir(), "pi-sandbox-systemd-verify-"));

try {
  const unitDirectory = join(root, "usr/lib/systemd/system");
  const executableDirectory = join(root, "usr/libexec/pi-sandbox");
  await mkdir(unitDirectory, { recursive: true });
  await mkdir(executableDirectory, { recursive: true });
  for (const unit of ["pi-sandbox-identity-broker.socket", "pi-sandbox-identity-broker@.service"]) {
    await copyFile(join(repositoryRoot, "packaging/systemd", unit), join(unitDirectory, unit));
  }
  for (const target of ["basic.target", "shutdown.target", "sockets.target", "sysinit.target"]) {
    await writeFile(join(unitDirectory, target), `[Unit]\nDescription=${target}\n`);
  }
  const broker = join(executableDirectory, "pi-sandbox-identity-broker");
  await writeFile(broker, "#!/bin/sh\nexit 0\n");
  await chmod(broker, 0o755);

  await run("systemd-analyze", [
    "verify",
    `--root=${root}`,
    "pi-sandbox-identity-broker.socket",
    "pi-sandbox-identity-broker@.service",
  ]);
} finally {
  await rm(root, { recursive: true, force: true });
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      process.stdout.write(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
      process.stderr.write(chunk);
    });
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (/(?:Unknown key|Failed to parse).*ignoring/u.test(output)) {
        reject(new Error(`${command} reported an ignored systemd unit setting`));
      } else if (code === 0) resolvePromise();
      else reject(new Error(`${command} failed with ${signal ?? `exit code ${code}`}`));
    });
  });
}
