#!/usr/bin/env node

import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { preflightSmolvmRelease, releaseArguments } from "./build/release-preflight.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "", 10);
if (!Number.isInteger(nodeMajor) || nodeMajor < 24) {
  console.error(
    `release verification requires Node.js 24 or newer; found ${process.versions.node}`,
  );
  process.exit(1);
}

const environment = { ...process.env };
delete environment.NODE_ENV;
const { requireSmolvm, buildArguments } = releaseArguments(process.argv.slice(2), environment);
if (requireSmolvm) {
  environment.PI_SANDBOX_REQUIRE_SMOLVM = "1";
  await preflightSmolvmRelease(buildArguments, environment);
}
if (process.platform === "linux") environment.PI_SANDBOX_REQUIRE_BWRAP = "1";
environment.PI_SANDBOX_TEST_TMPDIR ??= "/var/tmp";

const commonChecks = [
  ["npm", ["run", "format:check"]],
  ["npm", ["run", "lint"]],
  ["npm", ["run", "typecheck"]],
  ["npm", ["run", "test:build-composition"]],
  ["npm", ["run", "test:distribution"]],
  ["npm", ["run", "test:version"]],
  ["npm", ["run", "test:release-preflight"]],
  [process.execPath, ["--test", "scripts/test/sbom.mjs"]],
  ["npm", ["run", "test:unit"]],
  ["npm", ["run", "test:integration"]],
  ["npm", ["run", "test:e2e"]],
];
const platformChecks =
  process.platform === "linux"
    ? [
        ["npm", ["run", "test:extension"]],
        ["npm", ["run", "test:broker"]],
        ["npm", ["run", "test:audit-collector"]],
        ["npm", ["run", "test:systemd"]],
        ["npm", ["run", "build"]],
        ["npm", ["run", "test:install"]],
      ]
    : process.platform === "darwin"
      ? [
          ["npm", ["run", "build:application"]],
          ["npm", ["run", "test:install:macos"]],
        ]
      : (() => {
          throw new Error(`release verification is unsupported on ${process.platform}`);
        })();
const checks = [
  ...commonChecks,
  ...platformChecks,
  [process.execPath, [join(repositoryRoot, "scripts/build-release.mjs"), ...buildArguments]],
];

for (const [command, args] of checks) {
  process.stdout.write(`\n==> ${command} ${args.join(" ")}\n`);
  await run(command, args);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: environment,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with ${signal ?? `exit code ${code}`}`));
    });
  });
}
