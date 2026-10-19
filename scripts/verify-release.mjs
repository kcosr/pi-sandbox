#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadDistribution } from "./build/distribution.mjs";
import { buildRelease, parseReleaseArguments, ReleaseArgumentError } from "./build-release.mjs";
import { createReleaseVerification, runVerificationCommand } from "./test/release-verification.mjs";

const repositoryRoot = dirname(dirname(fileURLToPath(import.meta.url)));
export async function verifyRelease(buildArguments) {
  const parsedArguments = parseReleaseArguments(buildArguments);
  if (parsedArguments.help) {
    process.stdout.write(
      "verify:release runs the complete verification suite, then builds and tests the release.\n",
    );
    await buildRelease(buildArguments);
    return;
  }
  const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "", 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 24) {
    throw new Error(
      `release verification requires Node.js 24 or newer; found ${process.versions.node}`,
    );
  }

  const environment = { ...process.env };
  delete environment.NODE_ENV;
  const distributionArguments = ["--distribution", parsedArguments.distribution];
  const extensionChecks = ["sandbox-extension", "git-extension"].map((name) => [
    process.execPath,
    [join(repositoryRoot, `scripts/test/${name}-package.mjs`), ...distributionArguments],
  ]);
  {
    const distribution = await loadDistribution(distributionArguments[1]);
    if (distribution.toolBundle)
      environment.PI_SANDBOX_TEST_TOOL_BUNDLE = distribution.toolBundle.directory;
  }
  if (process.platform === "linux") environment.PI_SANDBOX_REQUIRE_BWRAP = "1";
  if (process.platform === "darwin") {
    environment.PI_SANDBOX_REQUIRE_SEATBELT = "1";
    environment.PI_SANDBOX_TEST_BUN ??=
      environment.PI_SANDBOX_BUN ?? execFileSync("which", ["bun"], { encoding: "utf8" }).trim();
  }
  environment.PI_SANDBOX_TEST_TMPDIR ??= "/var/tmp";

  const commonChecks = [
    ["npm", ["run", "format:check"]],
    ["npm", ["run", "lint"]],
    ["npm", ["run", "typecheck"]],
    ["npm", ["run", "test:build-composition"]],
    ["npm", ["run", "test:distribution"]],
    ["npm", ["run", "test:version"]],
    [process.execPath, ["--test", "scripts/test/release-workflow.mjs"]],
    [process.execPath, ["--test", "scripts/test/sbom.mjs"]],
    ["npm", ["run", "test:unit"]],
    ["npm", ["run", "test:integration"]],
    ["npm", ["run", "test:e2e"]],
  ];
  const platformChecks =
    process.platform === "linux"
      ? [
          ...extensionChecks,
          ["npm", ["run", "test:broker"]],
          ["npm", ["run", "test:audit-collector"]],
          ["npm", ["run", "test:systemd"]],
          ["npm", ["run", "build"]],
          ["npm", ["run", "test:install"]],
        ]
      : process.platform === "darwin"
        ? [
            ...extensionChecks,
            [
              process.execPath,
              [join(repositoryRoot, "scripts/build-bundles.mjs"), ...distributionArguments],
            ],
            ["npm", ["run", "test:install:macos"]],
          ]
        : (() => {
            throw new Error(`release verification is unsupported on ${process.platform}`);
          })();
  const checks = [...commonChecks, ...platformChecks];

  for (const [command, args] of checks) {
    process.stdout.write(`\n==> ${command} ${args.join(" ")}\n`);
    await runVerificationCommand(command, args, { cwd: repositoryRoot, env: environment });
  }

  // Both callbacks are mandatory in this workflow; there is no test-skipping option.
  await buildRelease(buildArguments, createReleaseVerification(environment));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await verifyRelease(process.argv.slice(2));
  } catch (error) {
    console.error(`verify-release: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = error instanceof ReleaseArgumentError ? 2 : 1;
  }
}
