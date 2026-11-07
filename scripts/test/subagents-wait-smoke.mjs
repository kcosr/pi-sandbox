import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

/** Real, unpatched Pi RPC parent and packed SDK children; every provider is local. */
export async function testStandaloneSubagentWait({ root, directory, runtime, artifact }) {
  for (const waitForChildren of [true, false]) {
    await scenario({
      root,
      directory: join(directory, String(waitForChildren)),
      runtime,
      artifact,
      waitForChildren,
    });
  }
}

async function scenario({ root, directory, runtime, artifact, waitForChildren }) {
  const workspace = join(directory, "workspace");
  const state = join(directory, "agent");
  await mkdir(workspace, { recursive: true });
  await mkdir(state, { recursive: true });
  const config = join(directory, "subagents.json");
  await writeFile(
    config,
    JSON.stringify({
      maxConcurrent: 3,
      maxTotal: 10,
      cancelTimeoutMs: 2000,
      ...(waitForChildren ? { waitForChildren: true } : {}),
    }),
  );
  const observer = join(directory, "boundary-observer.mjs");
  await writeFile(
    observer,
    `export default function(pi) {
    const watched = new WeakSet();
    pi.on("turn_end", (event, ctx) => {
      const signal = ctx.signal;
      pi.appendEntry("acceptance:turn-end", { signalPresent: !!signal, aborted: signal?.aborted, stopReason: event.message.stopReason });
      if (signal && !watched.has(signal)) {
        watched.add(signal);
        signal.addEventListener("abort", () => pi.appendEntry("acceptance:abort", { aborted: signal.aborted }), { once: true });
      }
    });
  }\n`,
  );

  let phase = waitForChildren ? "staggered" : "default";
  let first = true;
  let spawnedC = false;
  let resumeTarget;
  let failure;
  let sequence = 0;
  const held = new Map();
  const closed = new Set();
  const parentCalls = [];
  const resultMarker = (id) => `WAIT_FIXTURE_RESULT_${id}`;
  const spawnCall = (id) => ({ name: "spawn_agent", args: { task: `WAIT_FIXTURE_CHILD_${id}` } });
  const send = (response, text, calls = []) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish_reason = null) =>
      response.write(
        `data: ${JSON.stringify({
          id: `wait-${++sequence}`,
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
          id: `wait-call-${sequence}-${index}`,
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
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const names = (body.tools ?? []).map((tool) => tool.function?.name);
      if (!names.includes("spawn_agent")) {
        const task = body.messages.filter((message) => message.role === "user").at(-1);
        const id = /WAIT_FIXTURE_CHILD_([A-Z]+)/u.exec(JSON.stringify(task))?.[1];
        assert(id, "Child request must have an explicit fixture task");
        if (id === "FAIL") {
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: { message: "WAIT_FIXTURE_FAILED", type: "invalid_request_error" },
            }),
          );
        } else {
          assert(!held.has(id), `Duplicate child request: ${id}`);
          held.set(id, response);
          response.once("close", () => closed.add(id));
        }
        return;
      }
      const messages = JSON.stringify(body.messages);
      const consumed = ["A", "B", "C", "RESUME", "DEFAULT"].filter((id) =>
        messages.includes(resultMarker(id)),
      );
      const consumedFailure =
        messages.includes("Outcome: failed") && messages.includes("WAIT_FIXTURE_FAILED");
      const consumedCancellation =
        messages.includes("Subagent cancelled by user:") &&
        messages.includes("Do not automatically restart or replace this task.");
      parentCalls.push({ phase, consumed, consumedFailure, consumedCancellation });
      if (first) {
        first = false;
        if (phase === "resume") {
          assert(resumeTarget);
          send(response, "", [
            {
              name: "resume_agent",
              args: { id: resumeTarget.id, message: "WAIT_FIXTURE_CHILD_RESUME" },
            },
          ]);
        } else {
          const ids = phase === "staggered" ? ["A", "B"] : [phase.toUpperCase()];
          send(response, "", ids.map(spawnCall));
        }
      } else if (phase === "staggered" && consumed.includes("A") && !spawnedC) {
        spawnedC = true;
        send(response, "", [spawnCall("C")]);
      } else {
        send(response, `PARENT_${phase.toUpperCase()}_ANSWER`);
      }
    } catch (error) {
      failure ??= error;
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let child;
  let lines;
  let ended;
  const messages = [];
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
                name: "Offline wait fixture",
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
        "--offline",
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
        observer,
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
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + chunk).slice(-12000);
    });
    lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        messages.push(event);
        assert.notEqual(event.type, "extension_error", JSON.stringify(event));
        assert(
          event.type !== "extension_ui_request" ||
            !["select", "confirm", "input", "editor"].includes(event.method),
          "Ordinary subagents must not require approvals",
        );
      } catch (error) {
        failure ??= error;
      }
    });
    const settled = (after = 0) =>
      messages.slice(after).filter((event) => event.type === "agent_settled");
    const entries = (kind, after = 0) =>
      messages
        .slice(after)
        .filter((event) => event.type === "entry_appended" && event.entry?.customType === kind)
        .map((event) => event.entry.data);
    const assistantText = (text, after = 0) =>
      messages
        .slice(after)
        .some(
          (event) =>
            event.type === "message_end" &&
            event.message?.role === "assistant" &&
            JSON.stringify(event.message.content).includes(text),
        );
    async function waitFor(predicate, description, timeout = 15000) {
      const deadline = Date.now() + timeout;
      while (!predicate()) {
        if (failure) throw failure;
        assert(
          child.exitCode === null && child.signalCode === null,
          `Pi exited during ${description}: ${stderr}`,
        );
        assert(
          Date.now() < deadline,
          `Timeout during ${description}: ${stderr}\n${JSON.stringify({ parentCalls, messages: messages.slice(-35) })}`,
        );
        await delay(10);
      }
      if (failure) throw failure;
    }
    async function rpc(type, fields = {}, timeout) {
      const id = `wait-rpc-${++sequence}`;
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      const find = () => messages.find((event) => event.type === "response" && event.id === id);
      await waitFor(find, type, timeout);
      assert(find().success, JSON.stringify(find()));
      return find().data;
    }
    async function observe(action, details = {}) {
      const requestId = `wait-observation-${++sequence}`;
      const response = await rpc("prompt", {
        message: `/subagents-rpc ${JSON.stringify({ version: 1, requestId, action, ...details })}`,
      });
      assert.equal(response.disposition, "handled");
      const find = () =>
        entries("pi-subagents:response").find((entry) => entry.requestId === requestId);
      await waitFor(find, "observation");
      assert(find().success, JSON.stringify(find()));
      return find().data;
    }
    async function assertWaiting(after = 0) {
      assert.equal(
        (await rpc("get_state")).isStreaming,
        true,
        "Parent must remain active at the final turn boundary",
      );
      assert.equal(settled(after).length, 0, "No intermediate agent_settled is allowed");
      assert(
        entries("acceptance:turn-end", after).some(
          (entry) => entry.stopReason === "stop" && entry.signalPresent && !entry.aborted,
        ),
        "Real turn_end context must retain a live abort signal",
      );
    }
    function release(id) {
      const response = held.get(id);
      assert(response && !response.destroyed, `Missing live child response: ${id}`);
      send(response, resultMarker(id));
    }
    async function startPhase(next) {
      phase = next;
      first = true;
      const after = messages.length;
      await rpc("prompt", { message: `Run ${phase} fixture.` });
      return after;
    }

    await rpc("get_commands");
    await rpc("prompt", { message: "Start the fixture." });
    if (!waitForChildren) {
      await waitFor(
        () => held.has("DEFAULT") && settled().length === 1,
        "default early settlement",
      );
      assert.equal((await observe("snapshot")).active, 1);
      release("DEFAULT");
      await waitFor(
        () =>
          parentCalls.some((call) => call.consumed.includes("DEFAULT")) && settled().length === 2,
        "ordinary idle callback",
      );
    } else {
      await waitFor(
        () => held.has("A") && held.has("B") && assistantText("PARENT_STAGGERED_ANSWER"),
        "first child wait",
      );
      await assertWaiting();
      release("A");
      await waitFor(
        () =>
          entries("pi-subagents:state").some((entry) => entry.total === 2 && entry.active === 1),
        "first child settles while its peer remains active",
      );
      await assertWaiting();
      assert.equal((await observe("snapshot")).active, 1);
      release("B");
      await waitFor(
        () => held.has("C") && parentCalls.filter((call) => call.phase === "staggered").length >= 4,
        "continuation spawning another child",
      );
      await assertWaiting();
      assert.equal((await observe("snapshot")).active, 1);
      assert(
        parentCalls.at(-1).consumed.includes("A") && parentCalls.at(-1).consumed.includes("B"),
      );
      release("C");
      await waitFor(() => settled().length === 1, "single final settlement");
      assert.equal(settled()[0].aborted, false);
      assert(
        parentCalls.at(-1).consumed.includes("A") &&
          parentCalls.at(-1).consumed.includes("B") &&
          parentCalls.at(-1).consumed.includes("C"),
        "The final parent request must consume all child results",
      );
      const beforeResume = await observe("snapshot");
      assert.equal(beforeResume.active, 0);
      resumeTarget = beforeResume.agents.find((agent) => agent.label === "WAIT_FIXTURE_CHILD_A");
      assert(resumeTarget);
      const resumed = await startPhase("resume");
      await waitFor(
        () => held.has("RESUME") && assistantText("PARENT_RESUME_ANSWER", resumed),
        "resumed child wait",
      );
      await assertWaiting(resumed);
      assert.equal((await observe("snapshot")).total, beforeResume.total);
      release("RESUME");
      await waitFor(() => settled(resumed).length === 1, "resumed child result consumption");
      assert.equal(settled(resumed)[0].aborted, false);
      assert(parentCalls.at(-1).consumed.includes("RESUME"));
      const afterResume = await observe("snapshot");
      assert.equal(
        afterResume.total,
        beforeResume.total,
        "Resume must not consume another spawn allowance",
      );
      assert.notEqual(
        afterResume.agents.find((agent) => agent.id === resumeTarget.id)?.taskId,
        resumeTarget.taskId,
      );

      const failed = await startPhase("fail");
      await waitFor(() => settled(failed).length === 1, "failed child incorporation");
      assert.equal(settled(failed)[0].aborted, false);
      assert(
        parentCalls.at(-1).consumedFailure,
        "Parent must consume the child failure before settling",
      );

      const cancelled = await startPhase("cancel");
      await waitFor(
        () => held.has("CANCEL") && assistantText("PARENT_CANCEL_ANSWER", cancelled),
        "user cancellation wait",
      );
      await assertWaiting(cancelled);
      const cancelTarget = (await observe("snapshot")).agents.find(
        (agent) => agent.label === "WAIT_FIXTURE_CHILD_CANCEL",
      );
      assert(cancelTarget);
      await observe("cancel", { id: cancelTarget.id, taskId: cancelTarget.taskId });
      await waitFor(() => settled(cancelled).length === 1, "user cancellation incorporation");
      assert.equal(settled(cancelled)[0].aborted, false);
      assert(
        parentCalls.at(-1).consumedCancellation,
        "Parent must consume the user cancellation before settling",
      );
      assert(
        closed.has("CANCEL"),
        "User cancellation must abort its actual child provider request",
      );

      const aborted = await startPhase("abort");
      await waitFor(
        () => held.has("ABORT") && assistantText("PARENT_ABORT_ANSWER", aborted),
        "parent abort wait",
      );
      await assertWaiting(aborted);
      await rpc("abort", {}, 3000);
      assert.equal(settled(aborted).length, 1);
      assert.equal(settled(aborted)[0].aborted, true);
      assert(
        entries("acceptance:abort", aborted).some((entry) => entry.aborted),
        "RPC abort must reach the live boundary signal",
      );
      const callsAfterAbort = parentCalls.length;
      assert.equal(
        (await observe("snapshot")).active,
        0,
        "Wait-mode parent abort cancels its active children",
      );
      assert(closed.has("ABORT"), "Parent abort must close the actual child provider request");
      await delay(350);
      assert.equal(
        parentCalls.length,
        callsAfterAbort,
        "An aborted wait cannot restart the parent",
      );
      assert.equal(settled(aborted).length, 1);

      const shutdown = await startPhase("eof");
      await waitFor(
        () => held.has("EOF") && assistantText("PARENT_EOF_ANSWER", shutdown),
        "EOF wait",
      );
      await assertWaiting(shutdown);
      const callsBeforeShutdown = parentCalls.length;
      child.stdin.end();
      await waitFor(
        () => child.exitCode !== null || child.signalCode !== null,
        "EOF shutdown",
        5000,
      );
      assert.equal(await ended, 0, stderr);
      assert.equal(
        parentCalls.length,
        callsBeforeShutdown,
        "Shutdown must not continue the parent",
      );
      assert(
        settled(shutdown).every((event) => event.aborted),
        "Shutdown cannot report successful settlement while children were unfinished",
      );
      assert(closed.has("EOF"), "Shutdown must close the child provider stream");
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await waitFor(() => child.exitCode !== null || child.signalCode !== null, "clean shutdown");
      assert.equal(await ended, 0, stderr);
    }
    console.log(
      `Packed subagents (${runtime}, waitForChildren=${waitForChildren}): settlement, callbacks and cancellation passed`,
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
