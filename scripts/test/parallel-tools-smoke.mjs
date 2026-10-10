import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";

// Each command needs its peer to start before it can finish. A serial worker fails
// explicitly instead of relying on an elapsed-time assertion.
function barrier(prefix, side) {
  const peer = side === "left" ? "right" : "left";
  return `printf ready > ${prefix}-${side}; for attempt in {1..400}; do test -f ${prefix}-${peer} && break; sleep 0.01; done; test -f ${prefix}-${peer} || exit 71; printf ${prefix}-${side}-ok`;
}

/** Exercise stock scheduling and real tool factories in either packaged consumer. */
export async function testParallelTools({
  launch,
  modelsPath,
  workspace,
  workspaceFiles = {
    write: (name, content) => writeFile(join(workspace, name), content),
    read: (name) => readFile(join(workspace, name), "utf8"),
  },
}) {
  const originalModels = await readFile(modelsPath, "utf8").catch((error) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  await workspaceFiles.write("parallel-edit.txt", "alpha\nbeta\ngamma\ndelta\n");
  const nestedScript = `
for (const result of await Promise.all([
  tools.bash({command:${JSON.stringify(barrier("nested", "left"))}}),
  tools.bash({command:${JSON.stringify(barrier("nested", "right"))}})
])) text(result);
for (const result of await Promise.all([
  tools.edit({path:"parallel-edit.txt",edits:[{oldText:"gamma",newText:"third"}]}),
  tools.edit({path:"./parallel-edit.txt",edits:[{oldText:"delta",newText:"fourth"}]}),
  tools.write({path:"parallel-queued.txt",content:"seed"}),
  tools.edit({path:"./parallel-queued.txt",edits:[{oldText:"seed",newText:"committed"}]})
])) text(result);
text(await tools.read({path:"parallel-edit.txt"}));
text(await tools.read({path:"parallel-queued.txt"}));
text("NESTED_PARALLEL_OK");`;
  const batches = [
    [
      { name: "bash", args: { command: barrier("ordinary", "left") } },
      { name: "bash", args: { command: barrier("ordinary", "right") } },
    ],
    [
      {
        name: "edit",
        args: { path: "parallel-edit.txt", edits: [{ oldText: "alpha", newText: "first" }] },
      },
      {
        name: "edit",
        args: { path: "./parallel-edit.txt", edits: [{ oldText: "beta", newText: "second" }] },
      },
    ],
    [{ name: "codemode", args: { code: nestedScript } }],
  ];
  let count = 0;
  let failure;
  let child;
  let stderr = "";
  let lines;
  let ended;
  const messages = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.url, "/v1/chat/completions");
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      const batch = batches[count++];
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: `parallel-${count}`, object: "chat.completion.chunk", created: 1, model: "parallel-fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (batch) {
        const calls = batch.map(({ name, args }, index) => {
          const tool = body.tools.find(
            (tool) => (tool.function?.name ?? tool.custom?.name) === name,
          );
          assert(tool, `Missing ${name} in actual Pi tool catalog`);
          return {
            index,
            id: `parallel-${count}-${index}`,
            type: tool.type,
            ...(tool.type === "custom"
              ? { custom: { name, input: args.code } }
              : { function: { name, arguments: JSON.stringify(args) } }),
          };
        });
        send({ role: "assistant", tool_calls: calls });
        send({}, "tool_calls");
      } else {
        send({ role: "assistant", content: "PARALLEL_SMOKE_DONE" });
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
  try {
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          "parallel-fixture": {
            baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
            api: "openai-completions",
            apiKey: "offline-placeholder",
            authHeader: false,
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
            models: [
              {
                id: "parallel-fixture",
                name: "Offline parallel fixture",
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
    child = launch([
      "--provider",
      "parallel-fixture",
      "--model",
      "parallel-fixture",
      "--tools",
      "read,write,edit,bash,codemode",
    ]);
    ended = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    void ended.catch((error) => {
      failure ??= error;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        messages.push(JSON.parse(line));
      } catch {
        failure ??= new Error(`Invalid parallel RPC message: ${line}`);
      }
    });
    child.stdin.write(
      `${JSON.stringify({ id: "parallel-prompt", type: "prompt", message: "Exercise parallel tools" })}\n`,
    );
    const deadline = Date.now() + 90000;
    while (!messages.some((message) => message.type === "agent_end")) {
      if (failure) throw failure;
      assert(child.exitCode === null && child.signalCode === null, `Pi exited: ${stderr}`);
      assert(
        Date.now() < deadline,
        `Parallel smoke timed out: ${stderr}\n${JSON.stringify(messages).slice(-8000)}`,
      );
      await delay(20);
    }
    if (failure) throw failure;
    assert.equal(count, 4, "All ordinary and nested tool batches must execute");
    const results = messages.filter((message) => message.type === "tool_execution_end");
    assert(results.length >= 5, JSON.stringify(messages));
    assert(
      results.every((message) => !message.isError),
      JSON.stringify(results),
    );
    const output = JSON.stringify(results);
    for (const marker of [
      "ordinary-left-ok",
      "ordinary-right-ok",
      "nested-left-ok",
      "nested-right-ok",
      "NESTED_PARALLEL_OK",
    ])
      assert(output.includes(marker), `Missing ${marker}: ${output}`);
    assert.equal(await workspaceFiles.read("parallel-edit.txt"), "first\nsecond\nthird\nfourth\n");
    assert.equal(await workspaceFiles.read("parallel-queued.txt"), "committed");
    child.stdin.end();
    const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
    try {
      assert.equal((await ended).code, 0, stderr);
    } finally {
      clearTimeout(timer);
    }
    assert(
      !messages.some((message) => message.type === "extension_error"),
      JSON.stringify(messages),
    );
  } finally {
    lines?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await ended.catch(() => undefined);
    }
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (originalModels !== undefined) await writeFile(modelsPath, originalModels);
    else await rm(modelsPath, { force: true });
  }
}
