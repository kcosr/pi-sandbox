import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";
import { buildRelease, parseReleaseArguments, ReleaseArgumentError } from "../build-release.mjs";
import { verifyRelease } from "../verify-release.mjs";
import { createReleaseVerification, runVerificationCommand } from "./release-verification.mjs";
import { prepareHostIndependentSmokeConfig } from "./packaged-smoke-config.mjs";

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const sourceRoot = join(repositoryRoot, "unused-upstream-fixture");
const extractedRelease = join(repositoryRoot, "unused-release-fixture");
const sourceContext = { repositoryRoot, sourceRoot };
const packagedContext = {
  repositoryRoot,
  extractedRelease,
  os: "linux",
  packagedConfig: { execution: { backend: "bubblewrap" } },
  layout: { allowConfigOverride: false },
};
const expectedUpstreamSuites = [
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
];

test("release entrypoints import without launching builds or verification", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-release-import-"));
  try {
    const imports = ["build-release.mjs", "verify-release.mjs"].map(
      (name) => pathToFileURL(join(repositoryRoot, "scripts", name)).href,
    );
    const result = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        `${imports.map((url) => `await import(${JSON.stringify(url)});`).join("\n")}\nconsole.log("import-only");`,
      ],
      { cwd: temporary, encoding: "utf8", timeout: 10000 },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, "import-only\n");
    assert.equal(result.stderr, "");
    assert.deepEqual(await readdir(temporary), []);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("both workflows reject unknown or incomplete arguments before work", async () => {
  for (const args of [["--skip-tests"], ["--verify"], ["--distribution"], ["--config", "--out"]]) {
    assert.throws(() => parseReleaseArguments(args), ReleaseArgumentError);
    await assert.rejects(buildRelease(args), ReleaseArgumentError);
    await assert.rejects(verifyRelease(args), ReleaseArgumentError);
  }
  for (const name of ["build-release.mjs", "verify-release.mjs"]) {
    const path = join(repositoryRoot, "scripts", name);
    const invalid = spawnSync(process.execPath, [path, "--skip-tests"], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(invalid.status, 2, invalid.stderr);
    assert.match(invalid.stderr, /unknown option: --skip-tests/);
    assert.equal(invalid.stdout, "");
    const help = spawnSync(process.execPath, [path, "--help"], {
      encoding: "utf8",
      timeout: 10000,
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /archive integrity/);
    assert.doesNotMatch(help.stdout, /==>/);
  }
});

test("build-only rejects a bad source pin and cleans its temporary tree", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-release-integrity-"));
  try {
    const archive = join(temporary, "wrong-source.tar.gz");
    await writeFile(archive, "invalid source bytes");
    const result = spawnSync(
      process.execPath,
      [
        join(repositoryRoot, "scripts/build-release.mjs"),
        "--pi-source-archive",
        archive,
        "--out",
        join(temporary, "output"),
      ],
      {
        cwd: repositoryRoot,
        env: { ...process.env, TMPDIR: temporary },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Pi source archive SHA-256 mismatch/);
    assert.doesNotMatch(result.stdout, /Testing|Checking managed Pi API contracts/);
    assert.deepEqual(await readdir(temporary), ["wrong-source.tar.gz"]);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("source verification retains all contract, upstream and theme checks with its own environment", async () => {
  const commands = [];
  const environment = {
    NODE_ENV: "production",
    PI_SANDBOX_REQUIRE_BWRAP: "1",
    PI_SANDBOX_REQUIRE_SEATBELT: "1",
    PI_SANDBOX_TEST_TMPDIR: "/var/tmp/fixture",
    PI_SANDBOX_TEST_TOOL_BUNDLE: "/tools/fixture",
    PI_SANDBOX_TEST_BUN: "/tools/bun",
  };
  const verification = createReleaseVerification(environment, async (...command) =>
    commands.push(command),
  );
  environment.PI_SANDBOX_TEST_TMPDIR = "changed-after-creation";
  await verification.verifyPatchedSource(sourceContext);
  assert.equal(commands.length, 3);
  assert.deepEqual(commands[0].slice(0, 2), [
    process.execPath,
    [join(repositoryRoot, "scripts/test/pi-contract.mjs"), sourceRoot],
  ]);
  assert.equal(commands[1][0], "npm");
  assert.deepEqual(commands[1][1], ["exec", "--", "vitest", "run", ...expectedUpstreamSuites]);
  assert.equal(commands[1][2].cwd, sourceRoot);
  assert.deepEqual(commands[2].slice(0, 2), [
    "npm",
    ["exec", "--", "vitest", "run", "test/resource-loader-theme.test.ts"],
  ]);
  assert.equal(commands[2][2].cwd, join(sourceRoot, "packages/coding-agent"));
  for (const [, , options] of commands) {
    assert.equal(options.env.NODE_ENV, undefined);
    assert.equal(options.env.PI_SANDBOX_REQUIRE_BWRAP, "1");
    assert.equal(options.env.PI_SANDBOX_REQUIRE_SEATBELT, "1");
    assert.equal(options.env.PI_SANDBOX_TEST_TMPDIR, "/var/tmp/fixture");
    assert.equal(options.env.PI_SANDBOX_TEST_TOOL_BUNDLE, "/tools/fixture");
    assert.equal(options.env.PI_SANDBOX_TEST_BUN, "/tools/bun");
  }
  assert.equal(commands[1][2].env.PI_OFFLINE, "1");
  assert.equal(commands[2][2].env.PI_OFFLINE, "1");
  assert.equal(environment.NODE_ENV, "production");
});

test("source verification fails immediately at each failed gate", async () => {
  for (let failAt = 0; failAt < 3; failAt++) {
    let calls = 0;
    const failure = new Error(`source failure ${failAt}`);
    const verification = createReleaseVerification({}, async () => {
      if (calls++ === failAt) throw failure;
    });
    await assert.rejects(
      verification.verifyPatchedSource(sourceContext),
      (error) => error === failure,
    );
    assert.equal(calls, failAt + 1);
  }
});

test("packaged verification preserves platform gates and environment", async () => {
  const cases = [
    ["linux", "bubblewrap", false, "packaged-diagnostics-smoke.mjs"],
    ["linux", "direct", true, "packaged-diagnostics-smoke.mjs"],
    ["darwin", "seatbelt", true, "seatbelt-packaged-smoke.mjs"],
    ["darwin", "seatbelt", false, undefined],
    ["darwin", "direct", true, undefined],
  ];
  for (const [os, backend, allowConfigOverride, script] of cases) {
    const commands = [];
    const verification = createReleaseVerification(
      {
        NODE_ENV: "production",
        PI_SANDBOX_REQUIRE_BWRAP: "1",
        PI_SANDBOX_TEST_TMPDIR: "/var/tmp/release-fixture",
      },
      async (...command) => commands.push(command),
    );
    await verification.verifyPackagedRelease({
      ...packagedContext,
      os,
      packagedConfig: { execution: { backend } },
      layout: { allowConfigOverride },
    });
    assert.equal(commands.length, script === undefined ? 0 : 1);
    if (script === undefined) continue;
    const [command, args, options] = commands[0];
    assert.equal(command, process.execPath);
    assert.deepEqual(args, [
      join(repositoryRoot, "scripts/test", script),
      join(extractedRelease, "payload/pi-sandbox/pi-sandbox"),
      ...(os === "linux" ? [join(extractedRelease, "payload/pi-sandbox/defaults")] : []),
    ]);
    assert.equal(options.env.NODE_ENV, undefined);
    assert.equal(options.env.PI_SANDBOX_REQUIRE_BWRAP, "1");
    assert.equal(options.env.PI_SANDBOX_TEST_TMPDIR, "/var/tmp/release-fixture");
  }
});

test("packaged failures and child spawn/exit failures reject verification", async () => {
  const failure = new Error("packaged failure");
  const verification = createReleaseVerification({}, async () => {
    throw failure;
  });
  await assert.rejects(
    verification.verifyPackagedRelease(packagedContext),
    (error) => error === failure,
  );
  await assert.rejects(
    runVerificationCommand(process.execPath, ["-e", "process.exit(7)"]),
    /exit code 7/,
  );
  await assert.rejects(
    runVerificationCommand(join(repositoryRoot, "nonexistent-release-fixture-command"), []),
    /ENOENT/,
  );
  await runVerificationCommand(
    process.execPath,
    [
      "-e",
      "if (process.env.FIXTURE_MARKER !== 'present' || process.env.NODE_ENV !== undefined) process.exit(1)",
    ],
    { env: { FIXTURE_MARKER: "present" } },
  );
});

test("packaged smoke disables both services only in its temporary config copy", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-smoke-config-"));
  try {
    const original = join(temporary, "packaged-config.toml");
    const fixture = join(temporary, "fixture-config.toml");
    const config = parseToml(
      await readFile(join(repositoryRoot, "config/default/config.toml"), "utf8"),
    );
    config.identity = { mode: "broker" };
    config.audit = { enabled: true, facility: "local5" };
    const source = stringifyToml(config);
    await writeFile(original, source);
    await copyFile(original, fixture);
    assert.equal(
      await prepareHostIndependentSmokeConfig(fixture, "/work/secret", "/home/fixture-decoy"),
      true,
    );
    const actual = parseToml(await readFile(fixture, "utf8"));
    assert.deepEqual(actual.identity, { mode: "disabled" });
    assert.deepEqual(actual.audit, { enabled: false, facility: "local5" });
    assert.equal(actual.models_file, config.models_file);
    assert.equal(await readFile(original, "utf8"), source);
    await assert.rejects(
      prepareHostIndependentSmokeConfig(original + ".missing", "/secret", "/decoy"),
      /ENOENT/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
