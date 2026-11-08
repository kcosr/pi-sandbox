import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import { URL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { parse, stringify } from "@iarna/toml";

/** Qualify the packaged managed clone boundary using local Git HTTP and model fixtures. */
export async function testGitDestination({
  launch,
  configPath,
  modelsPath,
  workspace,
  compiledExtensions,
}) {
  assert(Array.isArray(compiledExtensions), "Compiled extension inventory is required");
  const compiledGit = compiledExtensions.find((extension) => extension.id === "git");
  if (!compiledGit) {
    console.log("Managed Git destination smoke: Git is absent from the compiled inventory");
    return;
  }
  assert(compiledGit.tools.includes("git_clone"), "Compiled Git inventory must declare git_clone");
  const originalConfig = await readFile(configPath, "utf8");
  const originalModels = await readFile(modelsPath, "utf8");
  const fixture = await mkdtemp(join(dirname(workspace), "git-destination-fixture-"));
  const seed = join(fixture, "seed");
  const remote = join(fixture, "remote.git");
  await mkdir(seed);
  const git = (args, cwd = seed) =>
    execFileSync("/usr/bin/git", ["-c", "init.templateDir=", ...args], {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: fixture,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: "pipe",
      timeout: 15000,
    });
  git(["init", "--quiet", "--initial-branch=main"]);
  await writeFile(join(seed, "README.md"), "MANAGED_SCRATCH_GIT_OK\n");
  git(["add", "README.md"]);
  git([
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "-qm",
    "fixture",
  ]);
  git(["branch", "feature"]);
  git(["tag", "fixture-v1"]);
  git(["clone", "--quiet", "--bare", seed, remote]);
  git(["--git-dir", remote, "update-server-info"]);
  let planned;
  let disabled = false;
  let failure;
  let served = 0;
  let held = 0;
  let sequence = 0;
  let running;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname !== "/v1/chat/completions") {
        if (url.pathname.startsWith("/cancel.git/")) {
          held++;
          return;
        }
        const file = resolve(remote, ...decodeURIComponent(url.pathname).split("/").slice(2));
        assert(file.startsWith(`${remote}${sep}`));
        try {
          const bytes = await readFile(file);
          served++;
          response.writeHead(200, { "content-type": "application/octet-stream" }).end(bytes);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          response.writeHead(404).end();
        }
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const names = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.custom?.name);
      assert.equal(
        names.includes("git_clone"),
        !disabled,
        "Administrative availability controls the model catalog",
      );
      assert(!names.includes("powershell"));
      const call = planned;
      planned = undefined;
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({
            id: `git-destination-${++sequence}`,
            object: "chat.completion.chunk",
            created: 1,
            model: "fixture",
            choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`,
        );
      if (call) {
        const definition = body.tools.find((tool) => tool.function?.name === "git_clone");
        assert(definition, "git_clone must be present");
        send({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `clone-${sequence}`,
              type: "function",
              function: {
                name: "git_clone",
                arguments: JSON.stringify({ repository: call }),
              },
            },
          ],
        });
        send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: "GIT_DESTINATION_DONE" });
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      failure ??= error;
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const config = parse(originalConfig);
  config.identity = { mode: "disabled" };
  config.audit.enabled = false;
  config.sessions.retention_days = 0;
  config.exports.enabled = false;
  config.execution.backend = "bubblewrap";
  config.network.mode = "none";
  config.filesystem.cwd_writable = false;
  config.filesystem.hidden_paths.push(fixture);
  config.extensions = {
    git: { allowed_hosts: ["127.0.0.1"], allowed_schemes: ["http"], destination: "sandbox_home" },
  };
  config.tools.git_clone = { mode: "ask", session_grant: "never", audit: false };
  const args = [
    "--provider",
    "fixture",
    "--model",
    "fixture",
    "--enable-extension",
    "git",
    "--tools",
    "git_clone,bash",
  ];
  const begin = async () => {
    await writeFile(configPath, stringify(config));
    running = rpc(launch(args), () => failure);
    await running.request("get_state");
  };
  const prompt = async (repository) => {
    planned = repository;
    const offset = running.messages.length;
    await running.request("prompt", { message: "Exercise the configured Git destination." });
    await running.wait(() =>
      running.messages.slice(offset).find((message) => message.type === "agent_settled"),
    );
    const result = running.messages
      .slice(offset)
      .find((message) => message.type === "tool_execution_end" && message.toolName === "git_clone");
    if (repository !== undefined) assert(result, "Expected clone result");
    return result;
  };
  try {
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          fixture: {
            api: "openai-completions",
            apiKey: "offline",
            baseUrl: `${base}/v1`,
            models: [
              {
                id: "fixture",
                name: "Offline fixture",
                reasoning: false,
                input: ["text"],
                contextWindow: 32768,
                maxTokens: 2048,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              },
            ],
          },
        },
      }),
    );
    const before = (await readdir(workspace)).sort();
    await begin();
    const repository = `${base}/sandbox-widget.git`;
    const result = await prompt(repository);
    assert.equal(result.isError, false, JSON.stringify(result));
    const destination = "/run/pi-sandbox/home/repos/sandbox-widget";
    assert(JSON.stringify(result.result).includes(destination));
    assert.equal(running.approvals, 1, "Sandbox acquisition retains ordinary approval");
    const check = await running.request("bash", {
      command: [
        `/usr/bin/git -C ${quote(destination)} status --porcelain`,
        `/usr/bin/git -C ${quote(destination)} symbolic-ref --short HEAD`,
        `/usr/bin/git -C ${quote(destination)} branch -r`,
        `/usr/bin/git -C ${quote(destination)} tag`,
        `/usr/bin/git -C ${quote(destination)} remote get-url origin`,
        `cat ${quote(`${destination}/README.md`)}`,
      ].join(" && "),
    });
    assert.equal(check.exitCode, 0, JSON.stringify(check));
    assert(
      check.output.startsWith("main\n"),
      `Checkout must be clean on the remote default: ${check.output}`,
    );
    for (const marker of [
      "origin/main",
      "origin/feature",
      "fixture-v1",
      repository,
      "MANAGED_SCRATCH_GIT_OK",
    ])
      assert(check.output.includes(marker), check.output);
    assert.deepEqual(
      (await readdir(workspace)).sort(),
      before,
      "Sandbox destination must not create host workspace files",
    );
    const repeated = await prompt(repository);
    assert.equal(repeated.isError, true);
    assert(/already exists/u.test(JSON.stringify(repeated.result)), JSON.stringify(repeated));
    running.decision = "Deny";
    const servedBeforeDeny = served;
    const denied = await prompt(`${base}/denied-widget.git`);
    assert.equal(denied.isError, true);
    assert.equal(served, servedBeforeDeny, "Denied approval must not acquire the repository");
    running.decision = "Allow once";
    planned = `${base}/cancel.git`;
    const offset = running.messages.length;
    await running.request("prompt", { message: "Exercise cancellation of an active clone." });
    await running.wait(() => held > 0);
    await running.request("abort");
    await running.wait(() =>
      running.messages.slice(offset).find((message) => message.type === "agent_settled"),
    );
    const alive = await running.request("bash", { command: "printf GIT_CANCEL_PEER_OK" });
    assert.equal(alive.output, "GIT_CANCEL_PEER_OK");
    await running.stop();
    running = undefined;
    assert.deepEqual((await readdir(workspace)).sort(), before);

    for (const [name, destinationMode] of [
      ["host-default-widget", undefined],
      ["host-explicit-widget", "host_cwd"],
    ]) {
      if (destinationMode === undefined) delete config.extensions.git.destination;
      else config.extensions.git.destination = destinationMode;
      config.tools.git_clone.mode = "allow";
      await begin();
      const hostResult = await prompt(`${base}/${name}.git`);
      assert.equal(hostResult.isError, false, JSON.stringify(hostResult));
      assert.equal(
        await readFile(join(workspace, name, "README.md"), "utf8"),
        "MANAGED_SCRATCH_GIT_OK\n",
      );
      const writeDenied = await running.request("bash", {
        command: `printf changed > ${quote(join(workspace, name, "README.md"))}`,
      });
      assert.notEqual(
        writeDenied.exitCode,
        0,
        "Host clone must remain supported with read-only sandbox CWD",
      );
      await running.stop();
      running = undefined;
      await rm(join(workspace, name), { recursive: true });
    }
    config.extensions.git.destination = "sandbox_home";
    config.tools.git_clone.mode = "disabled";
    disabled = true;
    args[args.length - 1] = "bash";
    await begin();
    const servedBeforeDisabled = served;
    await prompt(undefined);
    assert.equal(served, servedBeforeDisabled);
    await running.stop();
    running = undefined;
    assert(served > 0, "The approved clone must use host HTTP acquisition");
    console.log(
      "Managed Git: scratch import, refs/origin, approval/denial, cancellation, existing-target rejection, RO host defaults and disabled catalog passed",
    );
  } finally {
    try {
      await running?.stop();
    } finally {
      await writeFile(configPath, originalConfig);
      await writeFile(modelsPath, originalModels);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
      await rm(fixture, { recursive: true, force: true });
    }
  }
}

function rpc(child, externalFailure) {
  const messages = [];
  let stderr = "";
  let failure;
  let sequence = 0;
  let stopped;
  const ended = new Promise((resolve) => {
    child.once("error", (error) => {
      failure = error;
      resolve({ code: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16000);
  });
  child.stdin.on("error", (error) => {
    failure ??= error;
  });
  const lines = createInterface({ input: child.stdout });
  const client = {
    messages,
    approvals: 0,
    decision: "Allow once",
    async wait(predicate) {
      const deadline = Date.now() + 45000;
      for (;;) {
        if (failure || externalFailure()) throw failure ?? externalFailure();
        const found = predicate();
        if (found) return found;
        assert.equal(child.exitCode, null, `Git smoke Pi exited: ${stderr}`);
        assert.equal(child.signalCode, null, `Git smoke Pi terminated: ${stderr}`);
        assert(
          Date.now() < deadline,
          `Git smoke timeout: ${stderr}\n${JSON.stringify(messages).slice(-12000)}`,
        );
        await delay(20);
      }
    },
    async request(type, fields = {}) {
      const id = `git-rpc-${++sequence}`;
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      const response = await client.wait(() =>
        messages.find((message) => message.type === "response" && message.id === id),
      );
      assert.equal(response.success, true, JSON.stringify(response));
      return response.data;
    },
    stop() {
      return (stopped ??= (async () => {
        child.stdin.end();
        const timer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }, 10000);
        try {
          assert.equal((await ended).code, 0, stderr);
        } finally {
          clearTimeout(timer);
          lines.close();
        }
      })());
    },
  };
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      messages.push(message);
      assert.notEqual(message.type, "extension_error", JSON.stringify(message));
      if (message.type === "extension_ui_request" && message.method === "select") {
        client.approvals++;
        assert.deepEqual(
          message.options,
          ["Allow once", "Deny"],
          "Session grant is deliberately unavailable",
        );
        child.stdin.write(
          `${JSON.stringify({ type: "extension_ui_response", id: message.id, value: client.decision })}\n`,
        );
      }
    } catch (error) {
      failure ??= error;
    }
  });
  return client;
}
function quote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
