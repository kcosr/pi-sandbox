#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";

import { testRpcSessionLifecycle } from "./rpc-lifecycle-smoke.mjs";

const SANDBOX_TOOL_NAMES = Object.freeze(["read", "grep", "find", "ls", "write", "edit", "bash"]);

if (process.argv.length !== 4) {
  console.error("usage: packaged-diagnostics-smoke.mjs EXECUTABLE DEFAULTS_DIRECTORY");
  process.exit(2);
}

const sourceExecutable = resolve(process.argv[2]);
const sourceDefaultsDirectory = resolve(process.argv[3]);
const testTemporaryRoot = process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp";
const temporaryDirectory = await mkdtemp(join(testTemporaryRoot, "pi-sandbox-packaged-smoke-"));
let child;
let exitPromise;
let childFailure;
let stderr = "";

try {
  const runtimeDirectory = join(temporaryDirectory, "runtime");
  await cp(dirname(sourceExecutable), runtimeDirectory, { recursive: true });
  const defaultsDirectory = join(runtimeDirectory, "defaults");
  if (resolve(sourceDefaultsDirectory) !== resolve(dirname(sourceExecutable), "defaults")) {
    throw new Error("defaults directory must be adjacent to the packaged executable");
  }
  const workspace = join(temporaryDirectory, "workspace");
  const userState = join(workspace, ".pi-state");
  await mkdir(userState, { recursive: true });
  const hiddenFile = join(workspace, ".private-credentials");
  await writeFile(hiddenFile, "smoke-private-credential\n");
  const maskedFile = await prepareHostIndependentSmokeConfig(
    join(defaultsDirectory, "config.toml"),
    hiddenFile,
  );
  const sessionFixtures = await prepareSessionRetentionFixtures(userState, workspace);
  const releaseManifest = JSON.parse(
    await readFile(join(runtimeDirectory, "release-manifest.json"), "utf8"),
  );
  const compiledLibexecDirectory = releaseManifest?.layout?.libexecDir;
  const compiledConfigDirectory = releaseManifest?.layout?.configDir;
  if (
    typeof compiledLibexecDirectory !== "string" ||
    !compiledLibexecDirectory.startsWith("/") ||
    resolve(compiledLibexecDirectory) !== compiledLibexecDirectory
  ) {
    throw new Error("release manifest has an invalid compiled libexec directory");
  }
  if (
    typeof compiledConfigDirectory !== "string" ||
    !compiledConfigDirectory.startsWith("/") ||
    resolve(compiledConfigDirectory) !== compiledConfigDirectory ||
    releaseManifest.layout.configPath !== join(compiledConfigDirectory, "config.toml") ||
    releaseManifest.layout.defaultModelsPath !== join(compiledConfigDirectory, "models.json")
  ) {
    throw new Error("release manifest has an invalid compiled config directory");
  }
  const bubblewrapExecutable = resolveSmokeBubblewrap(
    releaseManifest,
    runtimeDirectory,
    compiledLibexecDirectory,
  );
  const sandboxExecutable = join(compiledLibexecDirectory, "pi-sandbox");
  if (typeof releaseManifest.layout.allowConfigOverride !== "boolean") {
    throw new Error("release manifest has an invalid config override policy");
  }
  let expectedConfigPath = releaseManifest.layout.configPath;
  let expectedModelsPath = releaseManifest.layout.defaultModelsPath;
  const configArguments = [];
  const overrideDirectory = join(temporaryDirectory, "selected-policy");
  await cp(defaultsDirectory, overrideDirectory, { recursive: true });
  const overridePath = join(overrideDirectory, "config.toml");
  const overrideModelsPath = join(overrideDirectory, "models.json");
  const overrideConfig = parseToml(await readFile(overridePath, "utf8"));
  overrideConfig.models_file = overrideModelsPath;
  await writeFile(overridePath, stringifyToml(overrideConfig));
  if (releaseManifest.layout.allowConfigOverride) {
    configArguments.push("--config", overridePath);
    expectedConfigPath = overridePath;
    expectedModelsPath = overrideModelsPath;
    // Prove that an explicit policy is selected even when the compiled default is invalid.
    await writeFile(join(defaultsDirectory, "config.toml"), "invalid default TOML");
  } else {
    await assertConfigOverrideRejected(sourceExecutable, overridePath);
  }
  const configuredModelIds = await readConfiguredModelIds(overrideModelsPath);
  const testBin = join(workspace, ".test-bin");
  await mkdir(testBin);
  const fdStub = join(testBin, "fd");
  await writeFile(fdStub, "#!/bin/sh\nexit 0\n");
  await chmod(fdStub, 0o755);

  const environment = {
    ...process.env,
    PATH: `${testBin}:${process.env.PATH ?? "/usr/bin:/bin"}`,
    PI_CODING_AGENT_DIR: userState,
  };
  delete environment.NODE_ENV;
  delete environment.PI_CODING_AGENT_SESSION_DIR;
  child = spawn(
    bubblewrapExecutable,
    [
      "--die-with-parent",
      "--new-session",
      "--ro-bind",
      "/",
      "/",
      "--proc",
      "/proc",
      "--dev-bind",
      "/dev",
      "/dev",
      "--dir",
      compiledConfigDirectory,
      "--ro-bind",
      defaultsDirectory,
      compiledConfigDirectory,
      "--ro-bind",
      runtimeDirectory,
      compiledLibexecDirectory,
      "--bind",
      workspace,
      workspace,
      "--chdir",
      workspace,
      "--",
      sandboxExecutable,
      ...configArguments,
      "--mode",
      "rpc",
      "--session",
      sessionFixtures.selected,
    ],
    { env: environment, stdio: ["pipe", "pipe", "pipe"] },
  );
  exitPromise = waitForExit(child);
  void exitPromise.catch((error) => {
    childFailure = error;
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const lines = createInterface({ input: child.stdout });
  const messages = [];
  lines.on("line", (line) => {
    try {
      messages.push(JSON.parse(line));
    } catch {
      // The RPC protocol must remain JSONL; retain the raw line for the final diagnostic.
      messages.push({ malformed: line });
    }
  });

  child.stdin.write(`${JSON.stringify({ id: "commands", type: "get_commands" })}\n`);
  await waitFor(
    () =>
      messages.find(
        (message) =>
          message.id === "commands" && message.type === "response" && message.success === true,
      ),
    "get_commands response",
  );
  const commandResponse = messages.find((message) => message.id === "commands");
  await assert.rejects(stat(sessionFixtures.expired), { code: "ENOENT" });
  assert((await stat(sessionFixtures.recent)).isFile(), "recent sessions must survive cleanup");
  assert(
    (await stat(sessionFixtures.selected)).mtimeMs >= sessionFixtures.startedAt - 1000,
    "selected old session must survive startup and refresh its last-use time",
  );
  const stateDirectory = join(userState, "pi-sandbox", "retention");
  const stateFiles = (await readdir(stateDirectory)).filter((file) => file.endsWith(".json"));
  assert.equal(
    stateFiles.length,
    1,
    "startup must record one retention attempt for the default session root",
  );
  const state = JSON.parse(await readFile(join(stateDirectory, stateFiles[0]), "utf8"));
  assert.equal(state.retentionDays, 365);
  assert(state.lastAttemptAt >= sessionFixtures.startedAt);
  const commands = commandResponse?.data?.commands;
  const extensionCommands = Array.isArray(commands)
    ? commands.filter((command) => command.source === "extension").map((command) => command.name)
    : undefined;
  if (
    extensionCommands === undefined ||
    JSON.stringify(extensionCommands) !== JSON.stringify(["sandbox"])
  ) {
    throw new Error(
      `compiled executable exposed unexpected extension commands: ${JSON.stringify(extensionCommands)}`,
    );
  }

  child.stdin.write(`${JSON.stringify({ id: "models", type: "get_available_models" })}\n`);
  await waitFor(
    () =>
      messages.find(
        (message) =>
          message.id === "models" && message.type === "response" && message.success === true,
      ),
    "get_available_models response",
  );
  const modelResponse = messages.find((message) => message.id === "models");
  const models = modelResponse?.data?.models;
  const advertisedModelIds = Array.isArray(models)
    ? models.map((model) =>
        typeof model?.provider === "string" && typeof model.id === "string"
          ? `${model.provider}/${model.id}`
          : undefined,
      )
    : undefined;
  if (
    advertisedModelIds === undefined ||
    advertisedModelIds.some((modelId) => modelId === undefined || !configuredModelIds.has(modelId))
  ) {
    throw new Error(
      `compiled executable exposed models outside the administrative catalog: ${JSON.stringify(models)}`,
    );
  }

  child.stdin.write(`${JSON.stringify({ id: "sandbox", type: "prompt", message: "/sandbox" })}\n`);
  await waitFor(
    () =>
      messages.find(
        (message) =>
          message.type === "extension_ui_request" &&
          message.method === "notify" &&
          typeof message.message === "string" &&
          message.message.includes("Pi Sandbox: initialized"),
      ),
    "/sandbox notification",
  );
  await waitFor(
    () =>
      messages.find(
        (message) =>
          message.id === "sandbox" && message.type === "response" && message.success === true,
      ),
    "/sandbox response",
  );

  const notification = messages.find(
    (message) => message.type === "extension_ui_request" && message.method === "notify",
  );
  const hasField = (name, value) =>
    notification?.message
      .split("\n")
      .some((line) => line.startsWith(`${name}:`) && line.slice(name.length + 1).trim() === value);
  if (
    !hasField("Config", expectedConfigPath) ||
    !hasField("Models", expectedModelsPath) ||
    !hasField("Extensions", "none") ||
    !hasField("Identity", "disabled")
  ) {
    throw new Error("/sandbox did not report the isolated packaged smoke configuration");
  }

  await testRpcSessionLifecycle({
    child,
    messages,
    waitFor,
    workspace,
    hiddenFile: maskedFile ? hiddenFile : undefined,
  });

  child.stdin.end();
  const exit = await exitPromise;
  if (exit.code !== 0) {
    throw new Error(
      `compiled executable exited with ${exit.signal ?? exit.code}: ${stderr.trim()}`,
    );
  }
  if (messages.some((message) => message.type === "extension_error" || "malformed" in message)) {
    throw new Error(`compiled executable emitted invalid RPC output: ${JSON.stringify(messages)}`);
  }
  assert(
    !stderr.includes("Checking for old sessions"),
    "RPC cleanup must not emit interactive progress",
  );

  console.log("packaged /sandbox diagnostics and RPC lifecycle smoke tests passed");
} finally {
  if (child !== undefined && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    await exitPromise?.catch(() => undefined);
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}

function resolveSmokeBubblewrap(releaseManifest, runtimeDirectory, compiledLibexecDirectory) {
  const bubblewrap = releaseManifest?.bubblewrap;
  if (
    typeof bubblewrap !== "object" ||
    bubblewrap === null ||
    Array.isArray(bubblewrap) ||
    typeof bubblewrap.path !== "string" ||
    !bubblewrap.path.startsWith("/") ||
    resolve(bubblewrap.path) !== bubblewrap.path
  ) {
    throw new Error("release manifest has an invalid Bubblewrap provider");
  }
  if (bubblewrap.mode === "system") return bubblewrap.path;
  if (bubblewrap.mode === "bundled") {
    if (bubblewrap.path !== join(compiledLibexecDirectory, "bwrap")) {
      throw new Error("release manifest bundled Bubblewrap path does not match libexec layout");
    }
    return join(runtimeDirectory, "bwrap");
  }
  throw new Error("release manifest has an unsupported Bubblewrap provider mode");
}

async function assertConfigOverrideRejected(executable, configPath) {
  const result = spawn(executable, ["--config", configPath, "--validate-installation"], {
    stdio: ["ignore", "ignore", "pipe"],
    timeout: 15_000,
  });
  let errorOutput = "";
  result.stderr.setEncoding("utf8");
  result.stderr.on("data", (chunk) => {
    errorOutput += chunk;
  });
  const exit = await waitForExit(result);
  if (exit.code !== 1 || !errorOutput.includes("This build does not permit --config")) {
    throw new Error("managed build did not reject the config override");
  }
}

async function waitFor(predicate, description) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (childFailure !== undefined) throw childFailure;
    if (child?.exitCode !== null || child?.signalCode !== null) {
      throw new Error(
        `compiled executable exited before ${description}: ${child?.signalCode ?? child?.exitCode}; ${stderr.trim()}`,
      );
    }
    const result = predicate();
    if (result !== undefined) return result;
    await delay(20);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function prepareHostIndependentSmokeConfig(configPath, hiddenFile) {
  const config = parseToml(await readFile(configPath, "utf8"));
  const tools = config.tools;
  if (typeof tools !== "object" || tools === null || Array.isArray(tools)) {
    throw new Error("packaged administrative config has no tool policy table");
  }
  // The build host need not carry executables required only on the target system.
  // It also need not run the production identity broker.
  // The release builder already validates the real selected extension config and inventory;
  // this smoke test exercises the packaged Pi application with its core sandbox tools.
  config.identity = { mode: "disabled" };
  config.sessions = { retention_days: 365 };
  const masksFile = config.execution?.backend === "bubblewrap";
  if (masksFile) config.filesystem.hidden_paths = [hiddenFile];
  config.extensions = {};
  config.tools = Object.fromEntries(
    SANDBOX_TOOL_NAMES.map((name) => {
      const policy = tools[name];
      if (policy === undefined) {
        throw new Error(`packaged administrative config is missing tools.${name}`);
      }
      return [name, policy];
    }),
  );
  await writeFile(configPath, stringifyToml(config), { mode: 0o644 });
  return masksFile;
}

async function prepareSessionRetentionFixtures(agentDir, workspace) {
  const startedAt = Date.now();
  const old = new Date(startedAt - 400 * 86_400_000);
  const encodedWorkspace = `--${workspace.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const directory = join(agentDir, "sessions", encodedWorkspace);
  await mkdir(directory, { recursive: true });
  const fixtures = { startedAt };
  for (const name of ["expired", "recent", "selected"]) {
    const file = join(directory, `${name}.jsonl`);
    await writeFile(
      file,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: randomUUID(),
        timestamp: old.toISOString(),
        cwd: workspace,
      })}\n`,
    );
    if (name !== "recent") await utimes(file, old, old);
    fixtures[name] = file;
  }
  return fixtures;
}

async function readConfiguredModelIds(modelsPath) {
  const models = JSON.parse(await readFile(modelsPath, "utf8"));
  return new Set(
    Object.entries(models.providers).flatMap(([provider, definition]) =>
      Array.isArray(definition.models)
        ? definition.models.map((model) => `${provider}/${model.id}`)
        : [],
    ),
  );
}

function waitForExit(child) {
  return new Promise((resolvePromise, reject) => {
    child.on("error", reject);
    child.on("exit", (code, signal) => resolvePromise({ code, signal }));
  });
}
