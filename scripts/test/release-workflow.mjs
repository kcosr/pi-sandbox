import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";
import {
  assertBunVersion,
  buildRelease,
  parseReleaseArguments,
  ReleaseArgumentError,
} from "../build-release.mjs";
import { verifyRelease } from "../verify-release.mjs";
import { createReleaseVerification, runVerificationCommand } from "./release-verification.mjs";
import {
  prepareHostIndependentSmokeConfig,
  prepareWritableSmokeWorkspace,
} from "./packaged-smoke-config.mjs";
import { testWorkspaceModes } from "./workspace-modes-smoke.mjs";

const repositoryRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const sourceRoot = join(repositoryRoot, "unused-upstream-fixture");
const extractedRelease = join(repositoryRoot, "unused-release-fixture");
const sourceContext = { repositoryRoot, sourceRoot };
const packagedContext = {
  repositoryRoot,
  extractedRelease,
  os: "linux",
  packagedConfig: { execution: { backend: "bubblewrap" } },
  layout: { configuration: { source: "local", allowConfigOverride: false } },
};
const expectedUpstreamSuites = [
  "packages/coding-agent/test/auth-check.test.ts",
  "packages/coding-agent/test/authoritative-model-runtime.test.ts",
  "packages/coding-agent/test/managed-auth-storage.test.ts",
  "packages/coding-agent/test/managed-external-input.test.ts",
  "packages/coding-agent/test/rpc-prompt-response-semantics.test.ts",
  "packages/ai/test/explicit-cloud.test.ts",
  "packages/ai/test/authoritative-sdk.test.ts",
  "packages/ai/test/node-http-proxy.test.ts",
  "packages/ai/test/openrouter-images.test.ts",
  "packages/ai/test/authoritative-oauth-environment.test.ts",
  "packages/ai/test/bedrock-credentials.test.ts",
  "packages/ai/test/google-vertex-api-key-resolution.test.ts",
  "packages/coding-agent/test/managed-model-runtime.test.ts",
  "packages/coding-agent/test/managed-main.test.ts",
  "packages/coding-agent/test/default-skill-paths.test.ts",
  "packages/coding-agent/test/managed-main-skills.test.ts",
  "packages/coding-agent/test/skills.test.ts",
  "packages/coding-agent/test/sdk-skills.test.ts",
  "packages/coding-agent/test/package-manager.test.ts",
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
  "packages/coding-agent/test/footer-width.test.ts",
  "packages/coding-agent/test/read-line-range-display.test.ts",
  "packages/coding-agent/test/agent-session-retry.test.ts",
  "packages/ai/test/json-parse.test.ts",
  "packages/ai/test/validation.test.ts",
  "packages/ai/test/transform-messages-cross-model-thinking.test.ts",
  "packages/ai/test/streaming-json.test.ts",
  "packages/coding-agent/test/compaction-summary-reasoning.test.ts",
  "packages/coding-agent/test/interactive-mode-extension-dialogs.test.ts",
  "packages/coding-agent/test/tool-execution-component.test.ts",
  "packages/coding-agent/test/login-dialog-device-code.test.ts",
  "packages/coding-agent/test/session-manager/file-operations.test.ts",
  "packages/coding-agent/test/session-manager/save-entry.test.ts",
  "packages/coding-agent/test/suite/regressions/11520-sdk-summary-oauth-auth.test.ts",
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

test("release compilation requires a stable Bun with isolated explicit trust", () => {
  for (const version of ["1.4.4", "1.4.5", "1.5.0", "2.0.0"])
    assert.equal(assertBunVersion(version), version);
  for (const version of ["1.3.14", "1.4.3", "0.99.0", "1.4.4-canary.1", "1.04.4", "invalid"])
    assert.throws(() => assertBunVersion(version), /Bun 1\.4\.4 or newer stable/);
});

test("an old Bun is rejected before build output or temporary source mutation", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-release-bun-minimum-"));
  try {
    const bin = join(temporary, "bin"),
      output = join(temporary, "output");
    await mkdir(bin);
    await mkdir(output);
    await writeFile(join(bin, "bun"), "#!/bin/sh\nprintf '1.3.14\\n'\n", { mode: 0o755 });
    await writeFile(join(output, "retained"), "previous output");
    for (const script of ["build-release.mjs", "verify-release.mjs"]) {
      const result = spawnSync(
        process.execPath,
        [join(repositoryRoot, "scripts", script), "--out", output],
        {
          cwd: repositoryRoot,
          env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temporary },
          encoding: "utf8",
          timeout: 10000,
        },
      );
      assert.equal(result.status, 1, result.stderr);
      assert.match(result.stderr, /Bun 1\.4\.4 or newer stable.*found 1\.3\.14/);
      assert.equal(result.stdout, "");
    }
    assert.deepEqual((await readdir(temporary)).sort(), ["bin", "output"]);
    assert.deepEqual(await readdir(output), ["retained"]);
    assert.equal(await readFile(join(output, "retained"), "utf8"), "previous output");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("build-only rejects a bad source pin and cleans its temporary tree", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-release-integrity-"));
  try {
    const archive = join(temporary, "wrong-source.tar.gz");
    const bin = join(temporary, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "bun"), "#!/bin/sh\nprintf '1.4.4\\n'\n", { mode: 0o755 });
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
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: temporary },
        encoding: "utf8",
        timeout: 10000,
      },
    );
    assert.equal(result.error, undefined);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /Pi source archive SHA-256 mismatch/);
    assert.doesNotMatch(result.stdout, /Testing|Checking managed Pi API contracts/);
    assert.deepEqual((await readdir(temporary)).sort(), ["bin", "wrong-source.tar.gz"]);
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
    [
      "exec",
      "--",
      "vitest",
      "run",
      "test/resource-loader-theme.test.ts",
      "test/resource-loader.test.ts",
    ],
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
      async () => {},
    );
    await verification.verifyPackagedRelease({
      ...packagedContext,
      os,
      packagedConfig: { execution: { backend } },
      layout: { configuration: { source: "local", allowConfigOverride } },
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

test("packaged smoke disables auditing only in its temporary config copy", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-smoke-config-"));
  try {
    const original = join(temporary, "packaged-config.toml");
    const fixture = join(temporary, "fixture-config.toml");
    const config = parseToml(
      await readFile(join(repositoryRoot, "config/default/config.toml"), "utf8"),
    );
    config.audit = { ...config.audit, enabled: true };
    config.subagents = { enabled: true, max_concurrent: 4, max_total: 32 };
    config.tools.subagents = { mode: "allow", session_grant: "never" };
    config.audit.tools.subagents = true;
    const source = stringifyToml(config);
    await writeFile(original, source);
    await copyFile(original, fixture);
    assert.equal(
      await prepareHostIndependentSmokeConfig(fixture, "/work/secret", "/home/fixture-decoy"),
      true,
    );
    const actual = parseToml(await readFile(fixture, "utf8"));
    assert.equal(actual.identity, undefined);
    const auditTools = { ...config.audit.tools };
    delete auditTools.subagents;
    assert.deepEqual(actual.audit, { enabled: false, tools: auditTools });
    assert.equal(actual.subagents, undefined);
    assert.equal(actual.tools.subagents, undefined);
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

test("packaged smoke composes partial common policy from the authored default without inherited Bash exceptions", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-smoke-partial-config-"));
  try {
    for (const commonBash of [false, true]) {
      const config = parseToml(
        await readFile(join(repositoryRoot, "config/default/config.toml"), "utf8"),
      );
      delete config.filesystem.cwd_writable;
      delete config.exports;
      delete config.tools.write;
      delete config.tools.edit;
      if (commonBash) {
        config.tools.bash = {
          mode: "ask",
          session_grant: "offer",
          known_read_only: { mode: "allow", session_grant: "never" },
          command_sets: {
            utility: {
              command: "utility",
              mode: "allow",
              session_grant: "never",
              operands: { min: 0, max: 0 },
            },
          },
        };
      } else delete config.tools.bash;
      const selectedTools = {
        bash: { mode: "ask", session_grant: "never" },
        write: { mode: "allow", session_grant: "never" },
        edit: { mode: "deny", session_grant: "never" },
      };
      config.workspace = {
        default: "review",
        allowed: ["review"],
        modes: {
          review: {
            filesystem: { cwd_writable: false },
            exports: { enabled: true },
            tools: selectedTools,
          },
        },
      };
      const fixture = join(temporary, `partial-${commonBash}.toml`);
      await writeFile(fixture, stringifyToml(config));
      await prepareHostIndependentSmokeConfig(fixture, "/work/secret", "/home/fixture-decoy");
      const actual = parseToml(await readFile(fixture, "utf8"));
      assert.equal(actual.filesystem.cwd_writable, true);
      assert.deepEqual(actual.exports, { enabled: false });
      assert.deepEqual(actual.workspace, {
        default: "host",
        allowed: ["host"],
        modes: { host: {} },
      });
      for (const name of ["bash", "write", "edit"])
        assert.deepEqual(actual.tools[name], selectedTools[name]);
      assert.equal(actual.tools.bash.known_read_only, undefined);
      assert.equal(actual.tools.bash.command_sets, undefined);
      assert.deepEqual(actual.tools.read, config.tools.read);
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});

test("Seatbelt smoke materializes mode-owned policies without enabling Bash or exports", async () => {
  const config = parseToml(
    await readFile(join(repositoryRoot, "config/default/config.seatbelt.toml"), "utf8"),
  );
  const selectedTools = {
    bash: config.tools.bash,
    write: config.tools.write,
    edit: config.tools.edit,
  };
  delete config.filesystem.cwd_writable;
  delete config.exports;
  for (const name of Object.keys(selectedTools)) delete config.tools[name];
  config.workspace = {
    default: "review",
    allowed: ["review"],
    modes: {
      review: {
        filesystem: { cwd_writable: false },
        exports: { enabled: true },
        tools: selectedTools,
      },
    },
  };
  const actual = prepareWritableSmokeWorkspace(config);
  assert.equal(actual.execution.backend, "seatbelt");
  assert.equal(actual.filesystem.cwd_writable, true);
  assert.deepEqual(actual.exports, { enabled: false });
  assert.deepEqual(actual.workspace, { default: "host", allowed: ["host"], modes: { host: {} } });
  for (const name of Object.keys(selectedTools))
    assert.deepEqual(actual.tools[name], selectedTools[name]);
  assert.equal(actual.tools.bash.mode, "disabled");
});

test("workspace-mode smoke prepares an omitted-common-policy fixture before launching the executable", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "pi-workspace-smoke-config-"));
  try {
    const config = parseToml(
      await readFile(join(repositoryRoot, "config/default/config.seatbelt.toml"), "utf8"),
    );
    const selectedTools = {
      bash: config.tools.bash,
      write: config.tools.write,
      edit: config.tools.edit,
    };
    delete config.filesystem.cwd_writable;
    delete config.exports;
    for (const name of Object.keys(selectedTools)) delete config.tools[name];
    config.workspace = {
      default: "review",
      allowed: ["review"],
      modes: {
        review: {
          filesystem: { cwd_writable: false },
          exports: { enabled: true },
          tools: selectedTools,
        },
      },
    };
    const source = stringifyToml(config);
    const fixture = join(temporary, "config.toml");
    await writeFile(fixture, source);
    const stopBeforeLaunch = new Error("fixture prepared; no native executable needed");
    let prepared;
    await assert.rejects(
      testWorkspaceModes({
        configPath: fixture,
        workspace: temporary,
        launch(args) {
          assert.deepEqual(args, ["--validate-installation"]);
          prepared = parseToml(readFileSync(fixture, "utf8"));
          throw stopBeforeLaunch;
        },
      }),
      (error) => error === stopBeforeLaunch,
    );
    assert.equal(prepared.config_version, 14, "first compiled check rejects the old schema");
    assert.equal(prepared.filesystem.cwd_writable, true);
    assert.deepEqual(prepared.exports, { enabled: false });
    for (const name of Object.keys(selectedTools))
      assert.deepEqual(prepared.tools[name], { mode: "ask", session_grant: "never" });
    assert.equal(prepared.workspace.modes.sandbox.filesystem.cwd_writable, false);
    assert.equal(prepared.workspace.modes.sandbox.exports.enabled, true);
    assert.equal(await readFile(fixture, "utf8"), source, "the supplied policy is restored");
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
