#!/usr/bin/env node

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { userInfo } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";
import { testManagedMcpCodemode } from "./mcp-codemode-smoke.mjs";

if (process.argv.length !== 4) {
  console.error("usage: smolvm-managed-smoke.mjs EXECUTABLE DEFAULTS_DIRECTORY");
  process.exit(2);
}
assert.equal(process.platform, "linux");
assert.equal(process.arch, "x64");
const executable = await realpath(resolve(process.argv[2]));
const defaults = await realpath(resolve(process.argv[3]));
const release = JSON.parse(
  await readFile(join(dirname(executable), "release-manifest.json"), "utf8"),
);
assert.equal(release.layout.allowConfigOverride, true, "Use a review build accepting --config");
assert.equal(release.smolvm?.version, "1.25.4");
assert.equal(typeof release.smolvm.path, "string");
const image = await realpath(process.env.PI_SANDBOX_SMOLVM_IMAGE ?? "");
const imageSha256 = process.env.PI_SANDBOX_SMOLVM_IMAGE_SHA256;
assert.match(imageSha256 ?? "", /^[a-f0-9]{64}$/u);
const temporary = await mkdtemp("/var/tmp/pim-");
const account = userInfo();
const userState = await mkdtemp(join(account.homedir, ".pi-smolvm-smoke-"));
const state = join(temporary, "state");
const workspace = join(temporary, "workspace");
const configPath = join(temporary, "config.toml");
const modelsPath = join(temporary, "models.json");
const children = new Set();
let forced = false;

try {
  await mkdir(state, { mode: 0o700 });
  await mkdir(workspace);
  const config = parseToml(await readFile(join(defaults, "config.toml"), "utf8"));
  config.models_file = modelsPath;
  config.identity = { mode: "disabled" };
  config.audit.enabled = false;
  config.sessions = { retention_days: 0 };
  config.execution = { backend: "smolvm" };
  config.network = { mode: "none" };
  config.filesystem = { cwd_writable: true, hidden_paths: [] };
  config.environment = { pi: { PI_CODING_AGENT_DIR: userState }, sandbox: {}, extensions: {} };
  config.extensions = {};
  config.codemode = { enabled: false };
  config.mcp = { servers: {} };
  config.tools = Object.fromEntries(
    ["read", "grep", "find", "ls", "write", "edit", "bash"].map((name) => [name, policy("allow")]),
  );
  config.smolvm = {
    image,
    image_sha256: imageSha256,
    state_directory: state,
    cpus: 1,
    memory_mib: 512,
    storage_gib: 1,
    overlay_gib: 1,
  };
  await writeFile(configPath, stringifyToml(config), { mode: 0o600 });
  await writeFile(
    modelsPath,
    JSON.stringify({
      providers: {
        fixture: {
          baseUrl: "http://127.0.0.1:9/v1",
          api: "openai-completions",
          apiKey: "offline",
          authHeader: false,
          models: [
            {
              id: "fixture",
              name: "Offline Fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    }),
    { mode: 0o600 },
  );
  const environment = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: account.homedir,
    LANG: "C.UTF-8",
    PI_CODING_AGENT_DIR: userState,
  };
  const launchArguments = (args) => {
    const child = spawn(executable, ["--config", configPath, ...args], {
      cwd: workspace,
      env: environment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    children.add(child);
    child.once("exit", () => children.delete(child));
    child.once("error", () => children.delete(child));
    return child;
  };
  const launch = (extra = []) => launchArguments(["--mode", "rpc", ...extra]);

  const assertExitWithoutVm = async ({ args, code, text }) => {
    const child = launchArguments(args);
    let output = "";
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", (chunk) => {
        output += chunk;
      });
    }
    child.stdin.end();
    const ended = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolve({ exitCode, signal }));
    });
    for (let n = 0; child.exitCode === null && child.signalCode === null && n < 1200; n++)
      await delay(25);
    assert(
      child.exitCode !== null || child.signalCode !== null,
      `CLI did not stop: ${args.join(" ")}`,
    );
    const exit = await ended;
    assert.equal(exit.exitCode, code, output);
    assert.equal(exit.signal, null, output);
    assert(output.includes(text), output);
    assert.deepEqual(await readdir(state), [], `CLI exit must not create a VM: ${args.join(" ")}`);
  };

  for (const item of [
    { args: ["--help"], code: 0, text: "Usage:" },
    { args: ["--version"], code: 0, text: "1.1.0" },
    { args: ["--mode", "invalid"], code: 1, text: "Invalid mode" },
    {
      args: ["--mode", "rpc", "--provider", "missing-provider", "--model", "missing-model"],
      code: 1,
      text: "missing-provider",
    },
  ])
    await assertExitWithoutVm(item);

  await writeFile(
    configPath,
    stringifyToml({ ...config, smolvm: { ...config.smolvm, image_sha256: "0".repeat(64) } }),
  );
  try {
    for (const mode of [["--mode", "rpc"], ["--print"]]) {
      await assertExitWithoutVm({
        args: [...mode, "--provider", "fixture", "--model", "fixture"],
        code: 1,
        text: "smolvm_image_digest_mismatch",
      });
    }
  } finally {
    await writeFile(configPath, stringifyToml(config));
  }

  const running = rpc(launch(["--provider", "fixture", "--model", "fixture"]));
  await running.request("get_state");
  const pids = await vmmPids(state);
  assert.equal(pids.length, 1, "One actual VMM must back this Pi process");
  const outside = join(temporary, "host-only.txt");
  await writeFile(outside, "host-private-fixture");
  const first = await running.request("bash", {
    command:
      "cat /proc/sys/kernel/random/boot_id; printf host-edit > result.txt; sleep 120 >background.log 2>&1 </dev/null & echo $! > background.pid",
  });
  assert.equal(first.data.exitCode, 0, JSON.stringify(first));
  await running.request("new_session");
  const second = await running.request("bash", {
    command: 'kill -0 "$(cat background.pid)" && cat /proc/sys/kernel/random/boot_id',
  });
  assert.equal(second.data.exitCode, 0, JSON.stringify(second));
  assert.equal(
    second.data.output.trim(),
    first.data.output.trim(),
    "Session replacement must reuse the VM",
  );
  assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "host-edit");
  const denied = await running.request("bash", { command: `cat ${shell(outside)}` });
  assert.notEqual(denied.data.exitCode, 0, "Guest must not read an unmounted host file");
  assert(!denied.data.output.includes("host-private-fixture"));
  const privateWrite = await running.request("bash", {
    command: `mkdir -p ${shell(dirname(outside))}; printf changed > ${shell(outside)}; cat ${shell(outside)}`,
  });
  assert.equal(privateWrite.data.exitCode, 0, JSON.stringify(privateWrite));
  assert.equal(privateWrite.data.output, "changed", "The guest's own root remains writable");
  assert.equal(await readFile(outside, "utf8"), "host-private-fixture");
  await running.stop();
  for (const pid of pids)
    assert.equal(await processAlive(pid), false, `VMM ${pid} survived normal EOF`);
  assert.deepEqual(await readdir(state), [], "Normal shutdown removes private VM state");

  await gitCloneSmoke({ config, configPath, modelsPath, temporary, workspace, launch });
  assert.deepEqual(await readdir(state), []);
  await writeFile(configPath, stringifyToml(config));
  await testManagedMcpCodemode({
    launch,
    configPath,
    modelsPath,
    workspace,
    userState,
    username: account.username,
    uid: account.uid,
  });
  assert.deepEqual(await readdir(state), [], "Every MCP/code-mode session must stop its VM");
  console.log(
    JSON.stringify(
      {
        result: "passed",
        executable,
        executableSha256: createHash("sha256")
          .update(await readFile(executable))
          .digest("hex"),
        runtime: release.smolvm,
        imageSha256,
        checks: [
          "help, version and invalid CLI exits without VM startup",
          "RPC and print mode reject a bad image before interface startup",
          "RPC session persistence",
          "host mount writes",
          "unmounted host denial",
          "normal EOF VMM death",
          "approved host Git clone and guest readback",
          "managed MCP and Code Mode",
        ],
      },
      null,
      2,
    ),
  );
} finally {
  for (const child of children) {
    child.stdin.end();
    for (let n = 0; children.has(child) && n < 400; n++) await delay(25);
    if (children.has(child)) {
      forced = true;
      child.kill("SIGKILL");
      for (let n = 0; children.has(child) && n < 40; n++) await delay(25);
    }
  }
  const remaining = await readdir(state).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  if (forced || children.size || remaining.length) {
    console.error(`Preserving uncertain fixture state: ${temporary}; Pi state: ${userState}`);
  } else {
    await rm(temporary, { recursive: true, force: true });
    await rm(userState, { recursive: true, force: true });
  }
}

function policy(mode) {
  return { mode, session_grant: "never", audit: false };
}
function shell(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
async function processAlive(pid) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    return !["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]);
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function vmmPids(directory) {
  const pids = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const filename = join(directory, entry.name);
    if (entry.isDirectory()) pids.push(...(await vmmPids(filename)));
    else if (entry.name === "agent.pid") {
      const pid = Number((await readFile(filename, "utf8")).split("\n")[0]);
      assert(Number.isSafeInteger(pid) && pid > 0);
      pids.push(pid);
    }
  }
  return pids;
}
function rpc(child) {
  const messages = [];
  let stderr = "",
    failure,
    sequence = 0;
  const ended = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  void ended.catch((error) => {
    failure = error;
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = {
    messages,
    onSelect: undefined,
    async wait(predicate, label) {
      for (let n = 0; n < 2400; n++) {
        if (failure) throw failure;
        const result = predicate();
        if (result !== undefined) return result;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Pi exited before ${label}: ${stderr}`);
        await delay(25);
      }
      throw new Error(`Timeout waiting for ${label}: ${stderr}`);
    },
    async request(type, fields = {}) {
      const id = `smolvm-${++sequence}`;
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      const reply = await client.wait(
        () => messages.find((m) => m.id === id && m.type === "response"),
        type,
      );
      assert.equal(reply.success, true, JSON.stringify(reply));
      return reply;
    },
    async stop() {
      child.stdin.end();
      for (let n = 0; child.exitCode === null && child.signalCode === null && n < 1200; n++)
        await delay(25);
      assert(child.exitCode !== null || child.signalCode !== null, `Pi did not stop: ${stderr}`);
      const exit = await ended;
      assert.equal(exit.code, 0, stderr);
      assert(!messages.some((m) => m.type === "extension_error"), JSON.stringify(messages));
    },
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.type === "extension_ui_request" && message.method === "select") {
        Promise.resolve(client.onSelect?.(message) ?? "Deny")
          .then((value) => {
            child.stdin.write(
              `${JSON.stringify({ type: "extension_ui_response", id: message.id, value })}\n`,
            );
          })
          .catch((error) => {
            failure = error;
          });
      }
    } catch {
      failure = new Error(`Invalid RPC output: ${line}`);
    }
  });
  return client;
}

async function gitCloneSmoke({ config, configPath, modelsPath, temporary, workspace, launch }) {
  const repository = join(temporary, "remote.git");
  const seed = join(temporary, "seed");
  await mkdir(seed);
  const marker = "host-clone-guest-readback";
  await writeFile(join(seed, "README.md"), marker);
  const gitEnv = {
    PATH: "/usr/bin:/bin",
    HOME: temporary,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
  };
  const git = (args, cwd = temporary) =>
    execFileSync("/usr/bin/git", args, { cwd, env: gitEnv, stdio: "pipe", timeout: 15000 });
  git(["init", "--quiet"], seed);
  git(["add", "README.md"], seed);
  git(
    [
      "-c",
      "user.name=Smoke",
      "-c",
      "user.email=smoke@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "fixture",
    ],
    seed,
  );
  git(["clone", "--quiet", "--bare", seed, repository]);
  git(["--git-dir", repository, "update-server-info"]);
  let requests = 0,
    served = 0,
    serverFailure;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname === "/v1/chat/completions") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const body = JSON.parse(Buffer.concat(chunks).toString());
        response.writeHead(200, { "content-type": "text/event-stream" });
        const send = (delta, finish_reason = null) =>
          response.write(
            `data: ${JSON.stringify({ id: "clone-smoke", object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
          );
        if (requests++ === 0) {
          const tool = body.tools.find((t) => (t.function?.name ?? t.custom?.name) === "codemode");
          assert(tool, "Code Mode must be offered");
          const code = `text(await tools.git_clone({repository:${JSON.stringify(`http://127.0.0.1:${server.address().port}/remote.git`)}})); text(await tools.read({path:"remote/README.md"}));`;
          send({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "clone-call",
                type: tool.type,
                ...(tool.type === "custom"
                  ? { custom: { name: "codemode", input: code } }
                  : { function: { name: "codemode", arguments: JSON.stringify({ code }) } }),
              },
            ],
          });
          send({}, "tool_calls");
        } else {
          assert(
            JSON.stringify(body.messages).includes(marker),
            "Guest read result must return to the model",
          );
          send({ role: "assistant", content: "CLONE_SMOKE_DONE" });
          send({}, "stop");
        }
        response.end("data: [DONE]\n\n");
      } else {
        assert.equal(request.method, "GET");
        assert(url.pathname.startsWith("/remote.git/"));
        const filename = resolve(
          repository,
          decodeURIComponent(url.pathname.slice("/remote.git/".length)),
        );
        assert(filename.startsWith(repository + sep));
        try {
          const data = await readFile(filename);
          served++;
          response.writeHead(200, { "content-type": "application/octet-stream" }).end(data);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          response.writeHead(404).end();
        }
      }
    } catch (error) {
      serverFailure ??= error;
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let running;
  try {
    const cloneConfig = JSON.parse(JSON.stringify(config));
    cloneConfig.codemode = { enabled: true };
    cloneConfig.extensions = { git: { allowed_hosts: ["127.0.0.1"], allowed_schemes: ["http"] } };
    cloneConfig.tools.git_clone = policy("ask");
    await writeFile(configPath, stringifyToml(cloneConfig));
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            api: "openai-completions",
            apiKey: "offline",
            authHeader: false,
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
            models: [
              {
                id: "fixture",
                name: "Fixture",
                reasoning: false,
                input: ["text"],
                contextWindow: 32768,
                maxTokens: 8192,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    running = rpc(launch(["--provider", "fixture", "--model", "fixture", "--tools", "+codemode"]));
    let approvals = 0;
    running.onSelect = async (message) => {
      assert(message.title.includes("git_clone"), message.title);
      await assert.rejects(readFile(join(workspace, "remote/README.md")), { code: "ENOENT" });
      approvals++;
      return "Allow once";
    };
    await running.request("get_state");
    await running.request("prompt", { message: "Clone the fixture and read its README" });
    await running.wait(
      () => running.messages.find((m) => m.type === "agent_end"),
      "Git clone agent end",
    );
    if (serverFailure) throw serverFailure;
    const result = running.messages.find(
      (m) => m.type === "tool_execution_end" && m.toolName === "codemode",
    );
    assert(result && !result.isError, JSON.stringify(result));
    assert.equal(approvals, 1);
    assert(requests >= 2 && served > 0);
    assert.equal(await readFile(join(workspace, "remote/README.md"), "utf8"), marker);
    await running.stop();
    running = undefined;
  } finally {
    await running?.stop().catch(() => undefined);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
