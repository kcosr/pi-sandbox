#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { parse, stringify } from "@iarna/toml";
import { testRpcSessionLifecycle } from "./rpc-lifecycle-smoke.mjs";
import { testManagedMcpCodemode } from "./mcp-codemode-smoke.mjs";

if (process.platform !== "darwin" || process.argv.length !== 3) {
  throw new Error(
    "usage on macOS: node scripts/test/seatbelt-packaged-smoke.mjs REVIEW_EXECUTABLE",
  );
}
const executable = resolve(process.argv[2]);
const payload = dirname(executable);
const manifest = JSON.parse(await readFile(join(payload, "release-manifest.json"), "utf8"));
assert.equal(manifest.layout.allowConfigOverride, true, "requires an explicit review build");
assert(manifest.executionBackends.includes("seatbelt"));
const temporary = await realpath(await mkdtemp("/private/tmp/pi-seatbelt-package-"));
const children = new Set();
try {
  const workspace = join(temporary, "workspace");
  const denied = join(workspace, "private");
  const state = join(temporary, "state");
  const home = join(temporary, "decoy-home");
  for (const directory of [denied, state, home]) await mkdir(directory, { recursive: true });
  const secret = join(denied, "secret.txt");
  await writeFile(secret, "DENIED_MARKER");
  const configPath = join(temporary, "config.toml");
  const modelsPath = join(temporary, "models.json");
  const config = parse(await readFile(join(payload, "defaults/config.toml"), "utf8"));
  config.models_file = modelsPath;
  config.execution = { backend: "seatbelt" };
  config.network = { mode: "none" };
  config.filesystem = { cwd_writable: true, hidden_paths: [], denied_paths: [denied] };
  config.identity = { mode: "disabled" };
  config.audit.enabled = false;
  config.sessions.retention_days = 365;
  config.environment = {
    pi: { PI_CODING_AGENT_DIR: state },
    sandbox: { HOME_EXPANSION_CHECK: join(temporary, "cache") },
    extensions: {},
  };
  await writeFile(configPath, stringify(config));
  await writeFile(modelsPath, await readFile(join(payload, "defaults/models.json")));
  const launch = (extra = []) => {
    const child = spawn(executable, ["--config", configPath, "--mode", "rpc", ...extra], {
      cwd: workspace,
      env: { ...process.env, HOME: home, PI_CODING_AGENT_DIR: state, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    child.once("close", () => children.delete(child));
    return child;
  };
  const child = launch();
  const messages = [];
  let stderr = "";
  let failure;
  child.on("error", (error) => (failure = error));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      messages.push(JSON.parse(line));
    } catch {
      failure = new Error(`invalid RPC output: ${line}`);
    }
  });
  async function waitFor(predicate, description) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const result = predicate();
      if (result !== undefined) return result;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`exit before ${description}: ${stderr}`);
      await delay(20);
    }
    throw new Error(`timeout waiting for ${description}: ${stderr}`);
  }
  let sequence = 0;
  async function request(type, fields = {}) {
    const id = `seatbelt-${++sequence}`;
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    const response = await waitFor(() => messages.find((m) => m.id === id), type);
    assert.equal(response.success, true, JSON.stringify(response));
    return response;
  }
  await request("get_state");
  await request("prompt", { message: "/sandbox" });
  const diagnostic = messages.find(
    (m) => m.type === "extension_ui_request" && m.method === "notify",
  );
  assert.match(diagnostic?.message ?? "", /seatbelt/i);
  const quoted = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const read = await request("bash", { command: `cat ${quoted(secret)}` });
  assert.notEqual(read.data.exitCode, 0);
  assert(!read.data.output.includes("DENIED_MARKER"));
  const outside = await request("bash", {
    command: `printf escape > ${quoted(join(home, "escape"))}`,
  });
  assert.notEqual(outside.data.exitCode, 0);
  await testRpcSessionLifecycle({
    child,
    messages,
    waitFor,
    workspace,
    hiddenFiles: [],
    expectedHomeExpansion: join(temporary, "cache"),
  });
  const exited = new Promise((resolve, reject) => {
    child.once("close", (code, signal) =>
      code === 0 ? resolve() : reject(new Error(`exit ${code}/${signal}: ${stderr}`)),
    );
  });
  child.stdin.end();
  await exited;
  const account = userInfo();
  await testManagedMcpCodemode({
    launch,
    configPath,
    modelsPath,
    workspace,
    userState: state,
    username: account.username,
    uid: process.geteuid(),
  });
  assert.equal(await readFile(secret, "utf8"), "DENIED_MARKER");
  console.log(
    "PASS compiled Seatbelt confinement, diagnostics, sessions, EOF, MCP, approvals and Code Mode",
  );
} finally {
  for (const child of children) {
    const exited = new Promise((resolve) => child.once("close", resolve));
    child.kill("SIGTERM");
    await exited;
  }
  await rm(temporary, { recursive: true, force: true });
}
