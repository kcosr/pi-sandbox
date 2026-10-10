import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join, resolve, sep } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, URL } from "node:url";
import { installExtensionArtifacts } from "./extension-artifacts.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
execFileSync(process.execPath, [join(root, "scripts/build-extensions.mjs")], { stdio: "inherit" });
const temporary = await mkdtemp("/var/tmp/pi-git-package-");
try {
  for (const variant of ["git-only", "sandbox-first", "git-first", "excluded"]) {
    const directory = join(temporary, variant);
    await mkdir(directory);
    const combined = variant === "sandbox-first" || variant === "git-first";
    const artifacts = await installExtensionArtifacts(
      root,
      directory,
      combined ? ["git-extension", "sandbox-extension"] : ["git-extension"],
    );
    assert.deepEqual(
      (await readdir(join(directory, "node_modules/@kcosr"))).sort(),
      combined ? ["pi-git-extension", "pi-sandbox-extension"] : ["pi-git-extension"],
    );
    await scenario(directory, variant, artifacts);
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
}

async function scenario(directory, variant, artifacts) {
  const workspace = join(directory, "workspace");
  const home = join(directory, "home");
  const state = join(home, "agent");
  const seed = join(directory, "seed");
  const remote = join(directory, "remote.git");
  for (const path of [workspace, state, seed]) await mkdir(path, { recursive: true });
  await writeFile(join(seed, "README.md"), "PACKED_GIT_OK\n");
  const git = (args, cwd = seed) =>
    execFileSync("/usr/bin/git", args, {
      cwd,
      env: {
        PATH: "/usr/bin:/bin",
        HOME: home,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_NOSYSTEM: "1",
      },
      stdio: "pipe",
      timeout: 15000,
    });
  git(["init", "--quiet"]);
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
  git(["clone", "--quiet", "--bare", seed, remote]);
  git(["--git-dir", remote, "update-server-info"]);
  const config = join(home, "git.json");
  await writeFile(
    config,
    JSON.stringify({ version: 1, allowed_hosts: ["127.0.0.1"], allowed_schemes: ["http"] }),
    { mode: 0o600 },
  );
  const sandboxConfig = join(home, "sandbox.json");
  await writeFile(
    sandboxConfig,
    JSON.stringify({
      version: 4,
      mode: "owned",
      userBash: false,
      backend: {
        kind: "bubblewrap",
        executable: "/usr/bin/bwrap",
        runtime: process.execPath,
        network: "none",
        processLifetime: "command",
        cwdWritable: true,
        hiddenPaths: [],
        environment: {},
      },
    }),
    { mode: 0o600 },
  );
  let modelRequests = 0,
    served = 0,
    failure;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (url.pathname !== "/v1/chat/completions") {
        const file = resolve(remote, ...decodeURIComponent(url.pathname).split("/").slice(2));
        assert(file.startsWith(`${remote}${sep}`));
        try {
          const content = await readFile(file);
          response.writeHead(200, { "content-type": "application/octet-stream" });
          served++;
          response.end(content);
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          response.writeHead(404);
          response.end();
        }
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const names = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.custom?.name);
      if (variant === "excluded")
        assert(!names.includes("git_clone"), "Excluded Git must stay inactive after new_session");
      else assert(names.includes("git_clone"), "Git must be registered in stock Pi");
      const step = modelRequests++;
      const phase = step % 3;
      const turn = Math.floor(step / 3) + 1;
      const base = `http://127.0.0.1:${server.address().port}`;
      let call;
      if (variant !== "excluded" && phase === 0)
        call = { name: "git_clone", args: { repository: `${base}/ordinary-${turn}.git` } };
      if (variant !== "excluded" && phase === 1)
        call = {
          name: "codemode",
          args: {
            code: `
text(await tools.git_clone({repository:${JSON.stringify(`${base}/nested-${turn}.git`)}}));
text(await tools.read({path:${JSON.stringify(join(workspace, `nested-${turn}/README.md`))}}));
let existing = false;
try { await tools.git_clone({repository:${JSON.stringify(`${base}/ordinary-${turn}.git`)}}); }
catch (error) { existing = String(error).includes("already exists"); }
if (!existing) throw new Error("Existing destination must be rejected");
let denied = false;
try { await tools.git_clone({repository:${JSON.stringify(`http://localhost:${server.address().port}/forbidden.git`)}}); }
catch (error) { denied = String(error).includes("not allowed"); }
if (!denied) throw new Error("Unlisted host must be rejected");
text("GIT_NESTED_OK");`,
          },
        };
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: `git-${step}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (call) {
        const tool = body.tools.find(
          (tool) => (tool.function?.name ?? tool.custom?.name) === call.name,
        );
        assert(tool, `Missing ${call.name}`);
        send({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `git-call-${step}`,
              type: tool.type,
              ...(tool.type === "custom"
                ? { custom: { name: call.name, input: call.args.code } }
                : { function: { name: call.name, arguments: JSON.stringify(call.args) } }),
            },
          ],
        });
        send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: "GIT_DONE" });
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
  let child, lines, ended;
  try {
    await writeFile(
      join(state, "models.json"),
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
                name: "Offline fixture",
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
    const gitArgs = [
      "-e",
      join(artifacts["git-extension"].directory, "dist/index.js"),
      "--git-config",
      config,
    ];
    const sandboxArgs = artifacts["sandbox-extension"]
      ? [
          "-e",
          join(artifacts["sandbox-extension"].directory, "dist/index.js"),
          "--sandbox-config",
          sandboxConfig,
        ]
      : [];
    child = spawn(
      process.execPath,
      [
        join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
        "--mode",
        "rpc",
        "--no-extensions",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-themes",
        ...(variant === "sandbox-first"
          ? [...sandboxArgs, ...gitArgs]
          : [...gitArgs, ...sandboxArgs]),
        "-e",
        "builtin:codemode",
        "--tools",
        "read,git_clone,codemode",
        ...(variant === "excluded" ? ["--exclude-tools", "git_clone"] : []),
        "--provider",
        "fixture",
        "--model",
        "fixture",
      ],
      {
        cwd: workspace,
        env: { PATH: process.env.PATH, HOME: home, PI_CODING_AGENT_DIR: state, NO_COLOR: "1" },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    ended = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => resolve(code));
    });
    void ended.catch((error) => {
      failure ??= error;
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const messages = [];
    lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const message = JSON.parse(line);
        messages.push(message);
        assert(
          message.type !== "extension_ui_request" ||
            !["select", "confirm", "input", "editor"].includes(message.method),
          "Standalone tools must not request managed approval",
        );
      } catch (error) {
        failure ??= error;
      }
    });
    async function waitFor(predicate) {
      const deadline = Date.now() + 30000;
      while (!predicate()) {
        if (failure) throw failure;
        assert(child.exitCode === null && child.signalCode === null, `Pi exited: ${stderr}`);
        assert(
          Date.now() < deadline,
          `Timeout: ${stderr}\n${JSON.stringify(messages).slice(-8000)}`,
        );
        await delay(20);
      }
      if (failure) throw failure;
    }
    for (let turn = 1; turn <= 2; turn++) {
      if (turn > 1) {
        child.stdin.write(`${JSON.stringify({ id: "new", type: "new_session" })}\n`);
        await waitFor(() => messages.some((m) => m.id === "new" && m.success));
      }
      child.stdin.write(`${JSON.stringify({ type: "prompt", message: "Exercise Git" })}\n`);
      await waitFor(() => messages.filter((m) => m.type === "agent_end").length === turn);
      if (variant !== "excluded")
        for (const kind of ["ordinary", "nested"])
          assert.equal(
            await readFile(join(workspace, `${kind}-${turn}/README.md`), "utf8"),
            "PACKED_GIT_OK\n",
          );
    }
    assert(!(await readdir(workspace)).includes("forbidden"));
    assert(!messages.some((m) => m.type === "extension_error"), JSON.stringify(messages));
    const results = messages.filter((m) => m.type === "tool_execution_end");
    const rejected = results.filter((m) => m.isError);
    assert.equal(rejected.length, variant === "excluded" ? 0 : 4, JSON.stringify(results));
    assert(
      rejected.every(
        (m) =>
          m.toolName === "git_clone" &&
          m.parentToolCallId &&
          /already exists|host is not allowed/u.test(JSON.stringify(m.result)),
      ),
      JSON.stringify(rejected),
    );
    if (variant !== "excluded") {
      assert(JSON.stringify(results).includes("GIT_NESTED_OK"));
      assert(served > 0);
    } else assert.equal(served, 0);
    child.stdin.end();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null);
    assert.equal(await ended, 0, stderr);
    console.log(`Packed ${variant}: ordinary/nested tools and repeated sessions passed`);
  } finally {
    lines?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await ended.catch(() => undefined);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}
