import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { longSubagentReport } from "./subagents-result-pages.mjs";

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
      forwardActivity: true,
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
    pi.registerTool({ name: "finish_batch", label: "Finish batch", description: "End this fixture tool turn.",
      parameters: { type: "object", properties: {}, additionalProperties: false },
      execute() { return Promise.resolve({ content: [{ type: "text", text: "WAIT_FIXTURE_FINISHED_BATCH" }], details: {}, terminate: true }); },
    });
    pi.on("input", async (event) => {
      if (event.text !== "WAIT_FIXTURE_HANDLED_INPUT") return;
      await new Promise((resolve) => setTimeout(resolve, 1250));
      return { action: "handled" };
    });
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

  let phase = waitForChildren ? "parenterror" : "default";
  let first = true;
  let spawnedC = false;
  let resumeTarget;
  let terminatedBatch = false;
  let releaseSettledParentFailure;
  let failure;
  let sequence = 0;
  const held = new Map();
  const closed = new Set();
  const parentCalls = [];
  const inputMarkers = [
    "WAIT_INPUT_STEER",
    "WAIT_INPUT_FOLLOW_UP",
    "WAIT_INPUT_PROMPT_STEER",
    "WAIT_INPUT_PROMPT_FOLLOW_UP",
  ];
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
      const consumed = ["A", "B", "C", "RESUME", "TERMINATE", "DEFAULT"].filter((id) =>
        messages.includes(resultMarker(id)),
      );
      const consumedFailure =
        messages.includes("Outcome: failed") && messages.includes("WAIT_FIXTURE_FAILED");
      const consumedCancellation =
        messages.includes("Subagent cancelled by user:") &&
        messages.includes("Do not automatically restart or replace this task.");
      const settledResultCount = body.messages.filter((message) =>
        JSON.stringify(message).includes(resultMarker("SETTLEDERROR")),
      ).length;
      parentCalls.push({
        phase,
        consumed,
        inputs: inputMarkers.filter((marker) => messages.includes(marker)),
        consumedFailure,
        consumedCancellation,
        settledResultCount,
      });
      if (phase === "parenterror" || (["activeerror", "settlederror"].includes(phase) && !first)) {
        if (phase === "settlederror") {
          await new Promise((resolve) => {
            releaseSettledParentFailure = resolve;
          });
        }
        if (phase === "activeerror") {
          const deadline = Date.now() + 5000;
          while (!held.has("ACTIVEERROR") && Date.now() < deadline) await delay(10);
          assert(
            held.has("ACTIVEERROR"),
            "Child request must start before the parent provider failure",
          );
        }
        response.writeHead(400, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: {
              message: `WAIT_PARENT_PROVIDER_${phase.toUpperCase()}`,
              type: "invalid_request_error",
            },
          }),
        );
      } else if (phase.startsWith("recovery")) {
        send(response, `PARENT_${phase.toUpperCase()}_ANSWER`);
      } else if (first) {
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
      } else if (phase === "terminate" && !terminatedBatch) {
        terminatedBatch = true;
        assert(names.includes("finish_batch"));
        send(response, "", [{ name: "finish_batch", args: {} }]);
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
                contextWindow: 262144,
                maxTokens: 65536,
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
    async function assertWaiting(after = 0, stopReason = "stop") {
      assert.equal(
        (await rpc("get_state")).isStreaming,
        true,
        "Parent must remain active at the final turn boundary",
      );
      assert.equal(settled(after).length, 0, "No intermediate agent_settled is allowed");
      assert(
        entries("acceptance:turn-end", after).some(
          (entry) => entry.stopReason === stopReason && entry.signalPresent && !entry.aborted,
        ),
        "Real turn_end context must retain a live abort signal",
      );
    }
    function release(id) {
      const response = held.get(id);
      assert(response && !response.destroyed, `Missing live child response: ${id}`);
      send(response, id === "A" ? longSubagentReport(resultMarker(id)) : resultMarker(id));
    }
    async function startPhase(next) {
      phase = next;
      first = true;
      const after = messages.length;
      await rpc("prompt", { message: `Run ${phase} fixture.` });
      return after;
    }
    async function assertProviderFailure(after, marker) {
      await waitFor(
        () => settled(after).length === 1,
        "ordinary parent provider failure settlement",
      );
      assert.equal(
        settled(after)[0].aborted,
        false,
        "A provider failure must retain native failed-run semantics",
      );
      assert(
        messages
          .slice(after)
          .some(
            (event) =>
              event.type === "message_end" &&
              event.message?.role === "assistant" &&
              event.message.stopReason === "error" &&
              event.message.errorMessage?.includes(marker),
          ),
        "The original parent provider error must remain visible",
      );
    }
    async function assertRecovery(next) {
      const after = await startPhase(next);
      await waitFor(() => settled(after).length === 1, "successful run after provider failure");
      assert.equal(settled(after)[0].aborted, false);
      assert(assistantText(`PARENT_${next.toUpperCase()}_ANSWER`, after));
      assert.equal((await observe("snapshot")).active, 0);
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
      await assertProviderFailure(0, "WAIT_PARENT_PROVIDER_PARENTERROR");
      assert.equal((await observe("snapshot")).total, 0, "Initial failure must have no children");
      await assertRecovery("recovery-empty");
      const staggered = await startPhase("staggered");
      await waitFor(
        () => held.has("A") && held.has("B") && assistantText("PARENT_STAGGERED_ANSWER"),
        "first child wait",
      );
      await assertWaiting(staggered);
      const beforeHandledInput = parentCalls.length;
      assert.equal(
        (
          await rpc("prompt", {
            message: "WAIT_FIXTURE_HANDLED_INPUT",
            streamingBehavior: "steer",
          })
        ).disposition,
        "handled",
      );
      assert.equal(
        parentCalls.length,
        beforeHandledInput,
        "Input handled before enqueueing must not trigger a speculative parent request",
      );
      await assertWaiting(staggered);
      for (const [index, [type, fields]] of [
        ["steer", {}],
        ["follow_up", {}],
        ["prompt", { streamingBehavior: "steer" }],
        ["prompt", { streamingBehavior: "followUp" }],
      ].entries()) {
        const marker = inputMarkers[index];
        const beforeInput = messages.length;
        const beforeCalls = parentCalls.length;
        assert.equal((await rpc(type, { message: marker, ...fields })).disposition, "queued");
        await waitFor(
          () =>
            parentCalls.at(-1).inputs.includes(marker) &&
            assistantText("PARENT_STAGGERED_ANSWER", beforeInput),
          `parent processes ${type}/${fields.streamingBehavior ?? "default"} while children wait`,
        );
        assert.equal(parentCalls.length, beforeCalls + 1);
        await assertWaiting(staggered);
        const pending = await observe("snapshot");
        assert.equal(pending.active, 2);
        assert.equal(pending.total, 2, "Parent input must not consume spawn allowance");
        assert(!closed.has("A") && !closed.has("B"), "Input must not cancel held child work");
      }
      release("A");
      await waitFor(
        () =>
          entries("pi-subagents:state").some((entry) => entry.total === 2 && entry.active === 1),
        "first child settles while its peer remains active",
      );
      await assertWaiting(staggered);
      assert.equal((await observe("snapshot")).active, 1);
      release("B");
      await waitFor(
        () =>
          held.has("C") &&
          parentCalls.at(-1).consumed.includes("A") &&
          parentCalls.at(-1).consumed.includes("B"),
        "continuation spawning another child",
      );
      await assertWaiting(staggered);
      assert.equal((await observe("snapshot")).active, 1);
      assert(
        parentCalls.at(-1).consumed.includes("A") && parentCalls.at(-1).consumed.includes("B"),
      );
      release("C");
      await waitFor(() => settled(staggered).length === 1, "single final settlement");
      assert.equal(settled(staggered)[0].aborted, false);
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
      const transcript = await rpc("get_messages");
      const longResult = transcript.messages.find(
        (message) =>
          message.role === "custom" &&
          message.customType === "pi-subagents:result" &&
          message.details?.taskId === resumeTarget.taskId,
      );
      assert(longResult);
      assert.match(longResult.content, /Report truncated[\s\S]*inspect_agent\(/u);
      assert(Buffer.byteLength(longResult.content) <= 16 * 1024);
      assert(
        !messages
          .slice(staggered)
          .some(
            (event) => event.type === "tool_execution_start" && event.toolName === "inspect_agent",
          ),
        "Unread report pages must not prevent normal final settlement",
      );
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

      const terminated = await startPhase("terminate");
      await waitFor(
        () =>
          held.has("TERMINATE") &&
          messages
            .slice(terminated)
            .some(
              (event) =>
                event.type === "tool_execution_end" &&
                event.toolName === "finish_batch" &&
                event.result?.terminate === true,
            ),
        "terminating tool result while a child is active",
      );
      await assertWaiting(terminated, "toolUse");
      release("TERMINATE");
      await waitFor(
        () => settled(terminated).length === 1,
        "terminated tool turn result consumption",
      );
      assert.equal(settled(terminated)[0].aborted, false);
      assert(parentCalls.at(-1).consumed.includes("TERMINATE"));

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

      const activeError = await startPhase("activeerror");
      await assertProviderFailure(activeError, "WAIT_PARENT_PROVIDER_ACTIVEERROR");
      assert.equal(
        (await observe("snapshot")).active,
        0,
        "Parent provider failure must cancel active wait-mode children",
      );
      assert(
        closed.has("ACTIVEERROR"),
        "Parent provider failure must close the child provider request",
      );
      await assertRecovery("recovery-active");

      const beforeSettledError = await observe("snapshot");
      const settledError = await startPhase("settlederror");
      await waitFor(
        () => held.has("SETTLEDERROR") && releaseSettledParentFailure,
        "parent provider request held while its child finishes",
      );
      release("SETTLEDERROR");
      const settledErrorTotal = beforeSettledError.total + 1;
      await waitFor(
        () =>
          entries("pi-subagents:state", settledError).some(
            (entry) => entry.total === settledErrorTotal && entry.active === 0,
          ),
        "child finishes before parent provider failure",
      );
      const completedBeforeError = await observe("snapshot");
      assert.equal(completedBeforeError.active, 0);
      assert.equal(completedBeforeError.total, settledErrorTotal);
      assert.equal(
        completedBeforeError.agents.find(
          (agent) => agent.label === "WAIT_FIXTURE_CHILD_SETTLEDERROR",
        )?.status,
        "completed",
      );
      assert.equal(settled(settledError).length, 0);
      assert.equal(parentCalls.at(-1).settledResultCount, 0);
      releaseSettledParentFailure();
      await assertProviderFailure(settledError, "WAIT_PARENT_PROVIDER_SETTLEDERROR");
      await assertRecovery("recovery-settled");
      assert.equal(
        parentCalls.at(-1).settledResultCount,
        1,
        "Recovery must consume the completed child's callback exactly once",
      );
      assert.equal(
        (await observe("snapshot")).total,
        settledErrorTotal,
        "Delivering a completed callback after failure must not consume spawn allowance",
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
      await delay(1250);
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
