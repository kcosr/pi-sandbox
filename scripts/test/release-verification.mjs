import { spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRepositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

/** These two callbacks own all behavioral checks run inside the builder's temporary trees. */
export function createReleaseVerification(environment, runCommand = runVerificationCommand) {
  const verificationEnvironment = { ...environment };
  delete verificationEnvironment.NODE_ENV;
  return {
    async verifyPatchedSource({ repositoryRoot, sourceRoot }) {
      process.stdout.write("Checking managed Pi API contracts against patched declarations\n");
      await runCommand(
        process.execPath,
        [join(repositoryRoot, "scripts/test/pi-contract.mjs"), sourceRoot],
        { env: verificationEnvironment },
      );

      process.stdout.write("Testing the managed Pi integration seams\n");
      await runCommand(
        "npm",
        [
          "exec",
          "--",
          "vitest",
          "run",
          "packages/coding-agent/test/auth-check.test.ts",
          "packages/coding-agent/test/managed-model-runtime.test.ts",
          "packages/coding-agent/test/managed-main.test.ts",
          "packages/coding-agent/test/managed-tools.test.ts",
          "packages/coding-agent/test/managed-version.test.ts",
          "packages/coding-agent/test/managed-tool-paths.test.ts",
          "packages/coding-agent/test/managed-extensions.test.ts",
          "packages/coding-agent/test/managed-session-sharing.test.ts",
          "packages/coding-agent/test/managed-session-cwd.test.ts",
          "packages/coding-agent/test/managed-session-maintenance.test.ts",
          "packages/coding-agent/test/managed-shutdown-status.test.ts",
          "packages/coding-agent/test/managed-mcp-codemode.test.ts",
          "packages/mcp/test/managed-transport.test.ts",
          "packages/codemode/test/managed-limits.test.ts",
          "packages/coding-agent/test/args.test.ts",
          "packages/coding-agent/test/print-mode.test.ts",
          "packages/coding-agent/test/compaction-serialization.test.ts",
          "packages/coding-agent/test/suite/agent-session-prompt.test.ts",
          "packages/coding-agent/test/mcp-extension.test.ts",
          "packages/coding-agent/test/mcp-manager-view.test.ts",
          "packages/coding-agent/test/suite/agent-session-codemode.test.ts",
          "packages/coding-agent/test/suite/agent-session-mcp.test.ts",
          "packages/coding-agent/test/suite/regressions/2835-tools-allowlist-filters-extension-tools.test.ts",
          "packages/codemode/test/sandbox.test.ts",
          "packages/codemode/test/worker-lifetime.test.ts",
          "packages/coding-agent/test/codemode-worker-admission.test.ts",
          "packages/coding-agent/test/managed-worker-admission.test.ts",
          "packages/coding-agent/test/model-resolver.test.ts",
          "packages/coding-agent/test/default-tools-setting.test.ts",
          "packages/coding-agent/test/settings-selector.test.ts",
          "packages/coding-agent/test/read-line-range-display.test.ts",
          "packages/coding-agent/test/agent-session-retry.test.ts",
          "packages/ai/test/json-parse.test.ts",
          "packages/ai/test/validation.test.ts",
          "packages/ai/test/transform-messages-cross-model-thinking.test.ts",
        ],
        { cwd: sourceRoot, env: { ...verificationEnvironment, PI_OFFLINE: "1" } },
      );

      // This upstream fixture resolves bundled themes from its package CWD.
      await runCommand(
        "npm",
        ["exec", "--", "vitest", "run", "test/resource-loader-theme.test.ts"],
        {
          cwd: join(sourceRoot, "packages/coding-agent"),
          env: { ...verificationEnvironment, PI_OFFLINE: "1" },
        },
      );
    },
    async verifyPackagedRelease({ repositoryRoot, extractedRelease, os, packagedConfig, layout }) {
      if (os === "linux") {
        process.stdout.write("Testing /sandbox through the packaged executable\n");
        await runCommand(
          process.execPath,
          [
            join(repositoryRoot, "scripts/test/packaged-diagnostics-smoke.mjs"),
            join(extractedRelease, "payload/pi-sandbox/pi-sandbox"),
            join(extractedRelease, "payload/pi-sandbox/defaults"),
          ],
          { env: verificationEnvironment },
        );
      } else if (packagedConfig.execution?.backend === "seatbelt" && layout.allowConfigOverride) {
        process.stdout.write("Testing Seatbelt through the packaged review executable\n");
        await runCommand(
          process.execPath,
          [
            join(repositoryRoot, "scripts/test/seatbelt-packaged-smoke.mjs"),
            join(extractedRelease, "payload/pi-sandbox/pi-sandbox"),
          ],
          { env: verificationEnvironment },
        );
      }
    },
  };
}

export function runVerificationCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? defaultRepositoryRoot,
      env: options.env,
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed with ${signal ?? `exit code ${code}`}`));
    });
  });
}
