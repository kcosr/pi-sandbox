import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFileSync, spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { installExtensionArtifacts } from "./extension-artifacts.mjs";
import { testStandaloneSubagentWait } from "./subagents-wait-smoke.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== "--distribution" || !args[1]))
  throw new Error("usage: subagents-extension-package.mjs [--distribution FILE]");
execFileSync(process.execPath, [join(root, "scripts/build-extensions.mjs"), ...args], {
  stdio: "inherit",
});
const temporary = await realpath(
  await mkdtemp(join(process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp", "pi-subagents-package-")),
);
// Deliberately outside the dependency-linked fixture: Pi must load this bare
// extracted tree through its public extension aliases, as documented for -e.
const extracted = await realpath(
  await mkdtemp(join(process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp", "pi-subagents-extracted-")),
);
const runtimes = [process.execPath];
try {
  const bun =
    process.env.PI_SANDBOX_TEST_BUN ??
    execFileSync("which", ["bun"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  if (bun && bun !== process.execPath) runtimes.push(bun);
} catch {
  /* Node-only hosts still qualify their available runtime. */
}
try {
  const artifacts = await installExtensionArtifacts(root, temporary, ["subagents-extension"]);
  const bare = join(extracted, "extension");
  await mkdir(bare);
  execFileSync("tar", [
    "-xzf",
    artifacts["subagents-extension"].archive,
    "--strip-components=1",
    "-C",
    bare,
  ]);
  await assert.rejects(access(join(extracted, "node_modules")));
  await assert.rejects(access(join(bare, "node_modules")));
  for (const [index, runtime] of runtimes.entries()) {
    await testStandaloneSubagentWait({
      root,
      directory: join(temporary, `wait-${index}`),
      runtime,
      artifact: artifacts["subagents-extension"],
    });
    await scenario(
      join(temporary, `runtime-${index}`),
      runtime,
      artifacts["subagents-extension"],
      true,
    );
    await scenario(
      join(extracted, `bare-${index}`),
      runtime,
      { ...artifacts["subagents-extension"], directory: bare },
      true,
    );
    await scenario(
      join(temporary, `disabled-${index}`),
      runtime,
      artifacts["subagents-extension"],
      false,
    );
  }
} finally {
  await rm(temporary, { recursive: true, force: true });
  await rm(extracted, { recursive: true, force: true });
}

async function scenario(directory, runtime, artifact, enabled) {
  const workspace = join(directory, "workspace");
  const state = join(directory, "agent");
  await mkdir(workspace, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(join(workspace, "sample.txt"), "SDK_CHILD_READ_OK\n");
  const config = join(directory, "subagents.json");
  await writeFile(
    config,
    JSON.stringify({
      enabled,
      forwardActivity: enabled,
      maxConcurrent: 2,
      maxTotal: 1,
      ...(enabled ? {} : { waitForChildren: true }),
    }),
  );
  let planned = enabled
    ? { name: "spawn_agent", args: { task: "Read sample.txt and report its contents." } }
    : undefined;
  let parentRequests = 0;
  let childRequests = 0;
  let childReads = 0;
  let failure;
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const names = (body.tools ?? []).map((tool) => tool.function?.name);
      const parent = names.includes("spawn_agent");
      let call;
      let text = "PARENT_DONE";
      if (!enabled) {
        assert(
          !names.some((name) =>
            [
              "spawn_agent",
              "resume_agent",
              "cancel_agent",
              "steer_agent",
              "inspect_agent",
            ].includes(name),
          ),
        );
        parentRequests++;
      } else if (parent) {
        parentRequests++;
        call = planned;
        planned = undefined;
      } else {
        childRequests++;
        assert(names.includes("read"));
        assert(!names.includes("resume_agent"));
        if (!body.messages.some((message) => message.role === "tool"))
          call = { name: "read", args: { path: "sample.txt" } };
        else {
          assert(JSON.stringify(body.messages).includes("SDK_CHILD_READ_OK"));
          childReads++;
          text = "SDK_CHILD_DONE";
        }
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: `fixture-${parentRequests}-${childRequests}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (call) {
        assert(names.includes(call.name));
        send({
          role: "assistant",
          tool_calls: [
            {
              index: 0,
              id: `call-${parentRequests}-${childRequests}`,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.args) },
            },
          ],
        });
        send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: text });
        send({}, "stop");
      }
      response.end("data: [DONE]\n\n");
    } catch (error) {
      failure ??= error;
      response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let child;
  let lines;
  let ended;
  try {
    await writeFile(
      join(state, "models.json"),
      JSON.stringify({
        providers: {
          fixture: {
            api: "openai-completions",
            apiKey: "offline",
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
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
    await writeFile(
      join(state, "settings.json"),
      JSON.stringify({
        retry: { enabled: false },
        compaction: { enabled: false },
        cacheWarming: "off",
      }),
    );
    child = spawn(
      runtime,
      [
        join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
        "--mode",
        "rpc",
        "--no-extensions",
        "--no-mcp",
        "--no-skills",
        "--no-prompt-templates",
        "--no-context-files",
        "--no-themes",
        "--provider",
        "fixture",
        "--model",
        "fixture",
        "-e",
        join(artifact.directory, "dist/index.js"),
      ],
      {
        cwd: workspace,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          PI_CODING_AGENT_DIR: state,
          PI_SUBAGENTS_CONFIG: config,
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    ended = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-12000);
    });
    const messages = [];
    lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        messages.push(event);
        assert(event.type !== "extension_error", JSON.stringify(event));
        assert(
          event.type !== "extension_ui_request" ||
            !["select", "confirm", "input", "editor"].includes(event.method),
          "Vanilla subagents must not require approvals",
        );
      } catch (error) {
        failure ??= error;
      }
    });
    async function waitFor(predicate) {
      const deadline = Date.now() + 45000;
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
    let sequence = 0;
    async function rpc(type, fields = {}) {
      const id = `rpc-${++sequence}`;
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      await waitFor(() =>
        messages.some((message) => message.type === "response" && message.id === id),
      );
      const response = messages.find((message) => message.type === "response" && message.id === id);
      assert(response.success, JSON.stringify(response));
      return response.data;
    }
    async function waitChildren(total, after = 0) {
      await waitFor(() =>
        messages
          .slice(after)
          .some(
            (event) =>
              event.type === "entry_appended" &&
              event.entry?.customType === "pi-subagents:state" &&
              event.entry.data?.total === total &&
              event.entry.data?.active === 0 &&
              event.entry.data.agents.every((agent) => agent.notifications !== "armed"),
          ),
      );
      for (let i = 0; i < 100; i++) {
        const state = await rpc("get_state");
        if (!state.isStreaming && !state.pendingMessageCount) return;
        await delay(20);
      }
      throw new Error("Parent did not settle after child notification");
    }
    const commands = await rpc("get_commands");
    const command = commands.commands.find((item) => item.name === "subagents-rpc");
    if (enabled) assert(command, JSON.stringify(commands));
    await rpc("prompt", { message: "Run the requested task." });
    if (!enabled) {
      await waitFor(() => messages.some((message) => message.type === "agent_settled"));
      assert.equal(childRequests, 0);
    } else {
      await waitChildren(1);
      assert(childReads > 0);
      async function observe(action, details = {}) {
        const requestId = `observation-${++sequence}`;
        const response = await rpc("prompt", {
          message: `/${command.name} ${JSON.stringify({ version: 1, requestId, action, ...details })}`,
        });
        assert.equal(response.disposition, "handled");
        const find = () =>
          messages.find(
            (event) =>
              event.type === "entry_appended" &&
              event.entry?.customType === "pi-subagents:response" &&
              event.entry.data?.requestId === requestId,
          );
        await waitFor(() => find());
        assert(find().entry.data.success, JSON.stringify(find()));
        return find().entry.data.data;
      }
      const snapshot = await observe("snapshot");
      assert.equal(snapshot.total, 1);
      assert.equal(snapshot.active, 0);
      assert.equal(snapshot.agents.length, 1);
      const agent = snapshot.agents[0];
      assert.equal(agent.status, "completed");
      const inspected = await observe("inspect", { id: agent.id, taskId: agent.taskId });
      assert.match(inspected.result, /SDK_CHILD_DONE/);
      planned = {
        name: "resume_agent",
        args: { id: agent.id, message: "Report the contents again." },
      };
      const beforeResume = messages.length;
      await rpc("prompt", { message: "Continue the child at the spawn cap." });
      await waitChildren(1, beforeResume);
      const resumedSnapshot = await observe("snapshot");
      assert.equal(resumedSnapshot.total, 1);
      assert.notEqual(resumedSnapshot.agents[0].taskId, agent.taskId);
      const activity = messages
        .filter(
          (event) =>
            event.type === "entry_appended" && event.entry?.customType === "pi-subagents:activity",
        )
        .map((event) => event.entry.data);
      assert(
        activity.some(
          (event) => event.kind === "assistant" && event.text.includes("SDK_CHILD_DONE"),
        ),
      );
      assert(activity.some((event) => event.kind === "tool_start" && event.toolName === "read"));
      assert(
        activity.some(
          (event) => event.kind === "tool_end" && event.result.includes("SDK_CHILD_READ_OK"),
        ),
      );
      assert(activity.some((event) => event.kind === "lifecycle" && event.status === "completed"));
      assert(activity.every((event) => event.version === 1 && event.childId === agent.id));
      assert(activity.some((event) => event.taskId === agent.taskId));
      assert(activity.some((event) => event.taskId === resumedSnapshot.agents[0].taskId));
      assert(
        activity.every(
          (event, index) => index === 0 || event.sequence > activity[index - 1].sequence,
        ),
      );
      assert(activity.every((event) => Buffer.byteLength(JSON.stringify(event)) <= 16 * 1024));
      const requestsBeforeCap = childRequests;
      planned = {
        name: "spawn_agent",
        args: { task: "This must be rejected at the total quota." },
      };
      const beforeCap = messages.length;
      await rpc("prompt", { message: "Try another child." });
      await waitFor(() =>
        messages.slice(beforeCap).some((event) => event.type === "agent_settled"),
      );
      assert.equal(childRequests, requestsBeforeCap);
      assert(
        messages
          .slice(beforeCap)
          .some(
            (event) =>
              event.type === "tool_execution_end" &&
              /limit|quota|maximum/iu.test(JSON.stringify(event)),
          ),
        "Total quota must reject further children",
      );
      const transcript = await rpc("get_messages");
      assert(
        !JSON.stringify(transcript).includes("observation-") &&
          !JSON.stringify(transcript).includes("pi-subagents:activity"),
        "Observation entries must not become model messages",
      );
      assert.equal((await observe("snapshot")).total, 1);
    }
    child.stdin.end();
    await waitFor(() => child.exitCode !== null || child.signalCode !== null);
    assert.equal(await ended, 0, stderr);
    assert.equal(await readFile(join(workspace, "sample.txt"), "utf8"), "SDK_CHILD_READ_OK\n");
    console.log(
      `Packed subagents (${runtime}, enabled=${enabled}): RPC parent, SDK children, bounded activity, observation and quotas passed`,
    );
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
