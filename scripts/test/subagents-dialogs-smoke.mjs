import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

/** Stock Pi RPC, extracted extension, file-backed inherited tools, and offline responses. */
export async function testStandaloneSubagentDialogs(options) {
  for (const forwardDialogs of [false, true])
    await scenario({
      ...options,
      directory: join(options.directory, String(forwardDialogs)),
      forwardDialogs,
    });
}

async function scenario({ root, directory, runtime, artifact, forwardDialogs }) {
  const cwd = join(directory, "workspace");
  const state = join(directory, "agent");
  await mkdir(cwd, { recursive: true });
  await mkdir(state, { recursive: true });
  const config = join(directory, "subagents.json");
  const counter = join(directory, "writes.txt");
  await writeFile(counter, "0");
  await writeFile(
    config,
    JSON.stringify({ forwardDialogs, forwardActivity: true, maxConcurrent: 2, maxTotal: 2 }),
  );
  const extension = join(directory, "question-tool.mjs");
  await writeFile(
    extension,
    `import { readFileSync, writeFileSync } from "node:fs";
import { getSubagentContext } from ${JSON.stringify(pathToFileURL(join(artifact.directory, "dist/context.js")).href)};
export default function(pi) {
  const initial = getSubagentContext(pi);
  let started;
  pi.on("session_start", () => { started = getSubagentContext(pi); });
  pi.registerTool({
    name: "question_fixture", label: "Question fixture", description: "Offline inherited tool fixture",
    exposure: "model-only",
    parameters: { type: "object", properties: { action: { type: "string" }, key: { type: "string" } }, required: ["action", "key"], additionalProperties: false },
    async execute(_id, args, signal, _update, ctx) {
      const identity = getSubagentContext(pi);
      if (JSON.stringify(initial) !== JSON.stringify(identity) || JSON.stringify(started) !== JSON.stringify(identity))
        throw new Error("Child context changed during its task");
      if (identity && !Object.isFrozen(identity)) throw new Error("Child context must be immutable");
      let answer;
      if (args.action === "write") {
        if (!identity) writeFileSync(${JSON.stringify(counter)}, String(Number(readFileSync(${JSON.stringify(counter)}, "utf8")) + 1));
      } else {
        answer = await ctx.ui.input("Exact shared title", args.key, { signal });
      }
      return { content: [{ type: "text", text: JSON.stringify({ identity: identity ?? null, hasUI: ctx.hasUI, action: args.action, key: args.key, blocked: args.action === "write" && !!identity, answer: answer ?? null }) }], details: {} };
    }
  });
}\n`,
  );

  let planned = [];
  let failure;
  let serial = 0;
  let holdChildren = true;
  const held = new Map();
  const reports = new Map();
  const messages = [];
  const send = (response, calls = [], text = "PARENT_DONE") => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: `dialogs-${++serial}`,
          object: "chat.completion.chunk",
          created: 1,
          model: "fixture",
          choices: [{ index: 0, delta, finish_reason }],
        })}\n\n`,
      );
    if (calls.length) {
      chunk({
        role: "assistant",
        tool_calls: calls.map((call, index) => ({
          index,
          id: `dialog-call-${serial}-${index}`,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      });
      chunk({}, "tool_calls");
    } else {
      chunk({ role: "assistant", content: text });
      chunk({}, "stop");
    }
    response.end("data: [DONE]\n\n");
  };
  const fixtureCall = (action, key) => ({ name: "question_fixture", args: { action, key } });
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const names = (body.tools ?? []).map((tool) => tool.function?.name);
      if (names.includes("spawn_agent")) {
        const calls = planned;
        planned = [];
        send(response, calls);
        return;
      }
      assert(names.includes("question_fixture"));
      const taskIndex = body.messages.findLastIndex((message) => message.role === "user");
      const key = /DIALOG_CHILD_([A-Z]+)/u.exec(JSON.stringify(body.messages[taskIndex]))?.[1];
      assert(key, "Every child has a named fixture task");
      const results = body.messages
        .slice(taskIndex + 1)
        .filter((message) => message.role === "tool")
        .map((message) => JSON.parse(message.content));
      if (!results.length) {
        if (holdChildren) held.set(key, response);
        else send(response, [fixtureCall("write", key)]);
      } else if (results.length === 1) {
        assert.equal(results[0].blocked, true, "Child writes must be rejected by the tool");
        send(response, [fixtureCall("ask", key)]);
      } else {
        reports.set(key, results.at(-1));
        send(response, [], `DIALOG_DONE_${key}`);
      }
    } catch (error) {
      failure ??= error;
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let child;
  let ended;
  let lines;
  let stderr = "";
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
                name: "Offline dialogs fixture",
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
        "-e",
        extension,
      ],
      {
        cwd,
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
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-12000);
    });
    lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        messages.push(event);
        assert.notEqual(event.type, "extension_error", JSON.stringify(event));
      } catch (error) {
        failure ??= error;
      }
    });
    const write = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    const waitFor = async (predicate) => {
      const deadline = Date.now() + 30000;
      while (!predicate()) {
        if (failure) throw failure;
        assert(child.exitCode === null && child.signalCode === null, `Pi exited: ${stderr}`);
        assert(
          Date.now() < deadline,
          `Timeout: ${stderr}\n${JSON.stringify(messages).slice(-10000)}`,
        );
        await delay(10);
      }
      if (failure) throw failure;
    };
    let sequence = 0;
    const rpc = async (type, fields = {}) => {
      const id = `dialogs-rpc-${++sequence}`;
      write({ id, type, ...fields });
      await waitFor(() => messages.some((event) => event.type === "response" && event.id === id));
      const reply = messages.find((event) => event.type === "response" && event.id === id);
      assert(reply.success, JSON.stringify(reply));
      return reply.data;
    };
    const observe = async (action, fields = {}) => {
      const requestId = `dialogs-observe-${++sequence}`;
      await rpc("prompt", {
        message: `/subagents-rpc ${JSON.stringify({ version: 1, requestId, action, ...fields })}`,
      });
      const find = () =>
        messages.find(
          (event) =>
            event.type === "entry_appended" &&
            event.entry?.customType === "pi-subagents:response" &&
            event.entry.data.requestId === requestId,
        );
      await waitFor(find);
      assert(find().entry.data.success, JSON.stringify(find()));
      return find().entry.data.data;
    };
    const prompt = async (calls) => {
      planned = calls;
      const after = messages.length;
      await rpc("prompt", { message: "Run the next fixture task." });
      await waitFor(() => messages.slice(after).some((event) => event.type === "agent_settled"));
    };
    const dialogs = () =>
      messages.filter((event) => event.type === "extension_ui_request" && event.method === "input");
    const waitIdle = async () => {
      for (let i = 0; i < 500; i++) {
        const snapshot = await observe("snapshot");
        const state = await rpc("get_state");
        if (
          snapshot.active === 0 &&
          snapshot.agents.every((agent) => agent.notifications !== "armed") &&
          !state.isStreaming &&
          !state.pendingMessageCount
        )
          return;
        await delay(10);
      }
      throw new Error("Parent callbacks did not settle");
    };

    await rpc("get_commands");
    await prompt([fixtureCall("write", "PARENT")]);
    const parentResult = messages.find(
      (event) => event.type === "tool_execution_end" && event.toolName === "question_fixture",
    );
    assert.equal(JSON.parse(parentResult.result.content[0].text).identity, null);
    assert.equal(await readFile(counter, "utf8"), "1");

    await prompt(
      ["A", "B"].map((key) => ({
        name: "spawn_agent",
        args: { task: `DIALOG_CHILD_${key}`, extended: true },
      })),
    );
    await waitFor(() => held.size === 2);
    assert.equal(dialogs().length, 0, "The parent turn must finish before children ask");
    holdChildren = false;
    for (const [key, response] of held) send(response, [fixtureCall("write", key)]);
    held.clear();
    if (forwardDialogs) {
      await waitFor(() => dialogs().length === 2);
      const requests = dialogs();
      assert.equal(new Set(requests.map((request) => request.id)).size, 2);
      for (const request of requests.toReversed()) {
        assert.equal(request.title, "Exact shared title");
        write({
          type: "extension_ui_response",
          id: request.id,
          value: `ANSWER_${request.placeholder}`,
        });
      }
    }
    await waitFor(() => reports.size === 2);
    await waitIdle();
    const first = await observe("snapshot");
    for (const key of ["A", "B"]) {
      const report = reports.get(key);
      const agent = first.agents.find((entry) => entry.id === report.identity.childId);
      assert(agent, "The tool's child context must identify an actual child");
      assert.equal(report.identity.taskId, agent.taskId);
      assert.equal(report.identity.parentSessionId, (await rpc("get_state")).sessionId);
      assert.equal(report.hasUI, forwardDialogs);
      assert.equal(report.answer, forwardDialogs ? `ANSWER_${key}` : null);
    }
    assert.notEqual(reports.get("A").identity.childId, reports.get("B").identity.childId);
    assert.equal(
      await readFile(counter, "utf8"),
      "1",
      "Child writes must not change parent-owned state",
    );
    if (!forwardDialogs) assert.equal(dialogs().length, 0);

    const original = reports.get("A").identity;
    await prompt([
      { name: "resume_agent", args: { id: original.childId, message: "DIALOG_CHILD_RESUME" } },
    ]);
    if (forwardDialogs) {
      await waitFor(() => dialogs().some((request) => request.placeholder === "RESUME"));
      const request = dialogs().find((entry) => entry.placeholder === "RESUME");
      write({ type: "extension_ui_response", id: request.id, cancelled: true });
    }
    await waitFor(() => reports.has("RESUME"));
    await waitIdle();
    const resumed = reports.get("RESUME");
    assert.equal(resumed.identity.childId, original.childId);
    assert.notEqual(resumed.identity.taskId, original.taskId);
    assert.equal(resumed.answer, null);
    assert.equal((await observe("snapshot")).total, 2);

    if (forwardDialogs) {
      await prompt([
        { name: "resume_agent", args: { id: original.childId, message: "DIALOG_CHILD_CANCEL" } },
      ]);
      await waitFor(() => dialogs().some((request) => request.placeholder === "CANCEL"));
      const pending = dialogs().find((request) => request.placeholder === "CANCEL");
      const running = (await observe("snapshot")).agents.find(
        (entry) => entry.id === original.childId,
      );
      await observe("cancel", { id: running.id, taskId: running.taskId });
      write({ type: "extension_ui_response", id: pending.id, value: "LATE_ANSWER" });
      await waitIdle();
      const cancelled = (await observe("snapshot")).agents.find((entry) => entry.id === running.id);
      assert.equal(cancelled.status, "cancelled");
      assert(!reports.has("CANCEL"), "Cancellation must not continue the child provider turn");

      await prompt([
        { name: "resume_agent", args: { id: original.childId, message: "DIALOG_CHILD_SHUTDOWN" } },
      ]);
      await waitFor(() => dialogs().some((request) => request.placeholder === "SHUTDOWN"));
    }
    child.stdin.end();
    const closeTimeout = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      assert.equal(await ended, 0, stderr);
    } finally {
      clearTimeout(closeTimeout);
    }
    assert.equal(await readFile(counter, "utf8"), "1");
    console.log(
      `Packed subagent dialogs (${runtime}, forwardDialogs=${forwardDialogs}): inherited model-only tools, session identity, concurrent replies, resume and shutdown passed`,
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
