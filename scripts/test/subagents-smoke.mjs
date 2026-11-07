import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";
import { parse, stringify } from "@iarna/toml";

const management = ["spawn_agent", "steer_agent", "cancel_agent", "resume_agent", "inspect_agent"];
const policy = (mode) => ({
  mode,
  session_grant: mode === "ask" ? "offer" : "never",
  audit: false,
});

/** Exercise real managed SDK children through the packaged parent, using only a local provider. */
export async function testManagedSubagents({ launch, configPath, modelsPath, workspace }) {
  const originalConfig = await readFile(configPath, "utf8");
  const originalModels = await readFile(modelsPath, "utf8");
  let planned = [];
  let failure;
  let sequence = 0;
  let childRequests = 0;
  let mcpCalls = 0;
  let overlapPending = false;
  let testingDisabled = false;
  let disabledRequests = 0;
  let running;
  const server = createServer(async (request, response) => {
    try {
      if (request.url === "/subagent-mcp" && request.method !== "POST") {
        response.writeHead(request.method === "DELETE" ? 200 : 405).end();
        return;
      }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (request.url === "/subagent-mcp") {
        if (body.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        let result;
        if (body.method === "initialize")
          result = {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "child-fixture", version: "1" },
          };
        else if (body.method === "tools/list")
          result = {
            tools: [
              {
                name: "marker",
                description: "Return a local fixture marker",
                inputSchema: { type: "object", properties: {} },
              },
            ],
          };
        else {
          assert.equal(body.method, "tools/call");
          assert.equal(body.params.name, "marker");
          mcpCalls++;
          result = { content: [{ type: "text", text: "MCP_CHILD_NESTED_OK" }] };
        }
        response.writeHead(200, {
          "content-type": "application/json",
          "mcp-session-id": "child-fixture",
        });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
        return;
      }
      assert.equal(request.url, "/v1/chat/completions");
      const names = (body.tools ?? []).map((tool) => tool.function?.name ?? tool.custom?.name);
      const parent = names.includes("spawn_agent");
      const instructions = JSON.stringify(
        body.messages.filter((message) => ["system", "developer"].includes(message.role)),
      );
      let calls = [];
      if (testingDisabled) {
        disabledRequests++;
        assert(!management.some((name) => names.includes(name)), "Disabled delegation is hidden");
        assert(!instructions.includes("SUBAGENT_GUIDANCE_FIXTURE"));
        assert(JSON.stringify(body.messages).includes("CHECK_DISABLED_EXTENSIONS"));
      } else if (parent) {
        assert(instructions.includes("SUBAGENT_GUIDANCE_FIXTURE"), "Parent guidance is enabled");
        calls = planned;
        planned = [];
        if (calls.length === 0 && overlapPending) {
          overlapPending = false;
          calls = [
            {
              name: "bash",
              args: {
                command:
                  "while [ ! -f .subagent-overlap-a ] || [ ! -f .subagent-overlap-b ]; do sleep 0.02; done; : > .subagent-overlap-release; printf MAIN_PARALLEL_OK",
                timeout: 10,
              },
            },
          ];
        }
      } else {
        childRequests++;
        assert(!instructions.includes("SUBAGENT_GUIDANCE_FIXTURE"), "Children cannot delegate");
        assert(!management.some((name) => names.includes(name)), "Children cannot delegate");
        assert(!names.includes("edit"), "Disabled tools cannot return in child sessions");
        assert(!names.includes("powershell"), "Stock tools cannot return in managed children");
        assert(names.includes("read") && names.includes("write"));
        const completed = body.messages.filter((message) => message.role === "tool").length;
        if (names.includes("codemode")) {
          const attempted = body.messages.some((message) =>
            message.tool_calls?.some(
              (call) => (call.function?.name ?? call.custom?.name) === "codemode",
            ),
          );
          if (attempted)
            assert(
              JSON.stringify(body.messages).includes("MCP_CHILD_NESTED_OK"),
              "Nested child tools failed",
            );
          if (!JSON.stringify(body.messages).includes("MCP_CHILD_NESTED_OK"))
            calls = [
              {
                name: "codemode",
                args: {
                  code: 'if(ALL_TOOLS.some(t=>["spawn_agent","resume_agent","edit","powershell"].includes(t.name))) throw new Error("excluded tool exposed"); text(await tools.read({path:"subagent-input.txt"})); text(await tools.write({path:"subagent-nested.txt",content:"NESTED_WRITE_OK"})); text(await tools.mcp__childfixture__marker({}));',
                },
              },
            ];
        } else if (completed === 0)
          calls = [{ name: "read", args: { path: "subagent-input.txt" } }];
        else if (completed === 1) {
          assert(JSON.stringify(body.messages).includes("MANAGED_CHILD_INPUT"));
          const identity = JSON.stringify(body.messages).includes("FIRST_PARALLEL_CHILD")
            ? "a"
            : "b";
          calls = [
            {
              name: "bash",
              args: {
                command: `: > .subagent-overlap-${identity}; while [ ! -f .subagent-overlap-release ]; do sleep 0.02; done; printf CHILD_PARALLEL_OK`,
                timeout: 10,
              },
            },
          ];
        } else if (completed === 2) {
          assert(
            JSON.stringify(body.messages).includes("CHILD_PARALLEL_OK"),
            "Child tool must overlap the parent tool",
          );
          calls = [
            {
              name: "write",
              args: { path: "subagent-output.txt", content: "MANAGED_CHILD_OUTPUT" },
            },
          ];
        }
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      const send = (delta, finish_reason = null) =>
        response.write(
          `data: ${JSON.stringify({ id: `managed-${++sequence}`, object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason }] })}\n\n`,
        );
      if (calls.length) {
        send({
          role: "assistant",
          tool_calls: calls.map((call, index) => {
            const definition = body.tools.find(
              (tool) => (tool.function?.name ?? tool.custom?.name) === call.name,
            );
            assert(definition, `Missing tool ${call.name}`);
            return {
              index,
              id: `call-${sequence}-${index}`,
              type: definition.type,
              ...(definition.type === "custom"
                ? { custom: { name: call.name, input: call.args.code } }
                : { function: { name: call.name, arguments: JSON.stringify(call.args) } }),
            };
          }),
        });
        send({}, "tool_calls");
      } else {
        send({
          role: "assistant",
          content: testingDisabled
            ? "DISABLED_CHECK_DONE"
            : parent
              ? "PARENT_DONE"
              : "MANAGED_CHILD_DONE",
        });
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
    const config = parse(originalConfig);
    config.identity = { mode: "disabled" };
    config.audit.enabled = false;
    config.sessions.retention_days = 0;
    config.filesystem.cwd_writable = true;
    config.subagents = { enabled: true, max_concurrent: 2, max_total: 2 };
    config.extension_guidance = { subagents: "SUBAGENT_GUIDANCE_FIXTURE" };
    config.codemode = { enabled: true, timeout_ms: 30000 };
    config.mcp = {
      servers: {
        childfixture: {
          enabled: true,
          transport: "http",
          url: `http://127.0.0.1:${server.address().port}/subagent-mcp`,
          exposure: "codemode",
          default_policy: policy("ask"),
        },
      },
    };
    config.tools.read = policy("ask");
    config.tools.write = policy("ask");
    config.tools.edit = policy("disabled");
    config.tools.bash = policy("allow");
    config.tools.subagents = policy("allow");
    await writeFile(configPath, stringify(config));
    await writeFile(join(workspace, "subagent-input.txt"), "MANAGED_CHILD_INPUT");
    await writeFile(
      modelsPath,
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
    running = client(
      launch([
        "--provider",
        "fixture",
        "--model",
        "fixture",
        "--tools",
        ["read", "write", "bash", "codemode", "mcp__childfixture__marker", ...management].join(","),
      ]),
      () => failure,
    );
    const commandList = await running.request("get_commands");
    const command = commandList.commands.find((entry) => entry.name === "agents-rpc");
    assert(command, `Managed observation command is registered: ${JSON.stringify(commandList)}`);
    assert(commandList.commands.some((entry) => entry.name === "extensions"));
    const observe = async (action = "snapshot", details = {}) => {
      const requestId = `inspect-${++sequence}`;
      const result = await running.request("prompt", {
        message: `/${command.name} ${JSON.stringify({ version: 1, requestId, action, ...details })}`,
      });
      assert.equal(result.disposition, "handled");
      const event = await running.wait(() =>
        running.messages.find(
          (message) =>
            message.type === "entry_appended" &&
            message.entry?.customType === "pi-subagents:response" &&
            message.entry.data?.requestId === requestId,
        ),
      );
      assert.equal(event.entry.data.success, true, JSON.stringify(event));
      return event.entry.data.data;
    };
    const prompt = async (text, calls) => {
      planned = calls;
      const offset = running.messages.length;
      await running.request("prompt", { message: text });
      await running.wait(() =>
        running.messages.slice(offset).find((message) => message.type === "agent_settled"),
      );
    };
    const toggleSubagents = async (enabled) => {
      const response = await running.request("prompt", {
        message: `/extensions ${enabled ? "enable" : "disable"} subagents`,
      });
      assert.equal(response.disposition, "handled");
    };
    await toggleSubagents(false);
    testingDisabled = true;
    await prompt("CHECK_DISABLED_EXTENSIONS", []);
    await running.idle();
    testingDisabled = false;
    assert.equal(disabledRequests, 1);
    await toggleSubagents(true);
    // A parent grant must immediately cover future child writes.
    await prompt("Write the parent marker.", [
      { name: "write", args: { path: "subagent-parent.txt", content: "parent" } },
    ]);
    assert.equal(running.prompts.length, 1);
    overlapPending = true;
    await prompt("Delegate two independent reads.", [
      {
        name: "spawn_agent",
        args: {
          task: "FIRST_PARALLEL_CHILD: Read subagent-input.txt, run the synchronization command, then write its marker to subagent-output.txt.",
        },
      },
      {
        name: "spawn_agent",
        args: {
          task: "SECOND_PARALLEL_CHILD: Read subagent-input.txt, run the synchronization command, then write its marker to subagent-output.txt.",
        },
      },
    ]);
    assert(
      running.messages.some(
        (event) =>
          event.type === "tool_execution_end" &&
          event.toolName === "bash" &&
          JSON.stringify(event.result).includes("MAIN_PARALLEL_OK"),
      ),
      "Parent tool must overlap both children",
    );
    await running.wait(() =>
      running.messages.findLast(
        (message) =>
          message.type === "entry_appended" &&
          message.entry?.customType === "pi-subagents:state" &&
          message.entry.data?.total === 2 &&
          message.entry.data?.active === 0,
      ),
    );
    await running.idle();
    const state = await observe();
    assert.equal(state.total, 2);
    assert.equal(state.agents.length, 2);
    assert(
      state.agents.every((agent) => agent.status === "completed"),
      JSON.stringify(state),
    );
    assert.equal(running.prompts.length, 2, "Concurrent children share the same read approval");
    assert(running.prompts[1].startsWith("Child "), "Child approval identifies its origin");
    assert.equal(
      await readFile(join(workspace, "subagent-output.txt"), "utf8"),
      "MANAGED_CHILD_OUTPUT",
    );
    const item = state.agents[0];
    const preview = await observe("inspect", { id: item.id, taskId: item.taskId });
    assert.match(preview.result, /MANAGED_CHILD_DONE/);
    // A child grant must also cover a later parent read.
    await prompt("Read the marker in the parent.", [
      { name: "read", args: { path: "subagent-input.txt" } },
    ]);
    assert.equal(running.prompts.length, 2);
    const beforeResume = running.messages.length;
    await prompt("Resume the child at the spawn cap.", [
      {
        name: "resume_agent",
        args: {
          id: item.id,
          message: "Confirm the completed task with Code Mode and the MCP marker.",
          extended: true,
        },
      },
    ]);
    await running.wait(() =>
      running.messages
        .slice(beforeResume)
        .findLast(
          (message) =>
            message.type === "entry_appended" &&
            message.entry?.customType === "pi-subagents:state" &&
            message.entry.data?.total === 2 &&
            message.entry.data?.active === 0,
        ),
    );
    await running.idle();
    assert.equal((await observe()).total, 2);
    assert.equal(mcpCalls, 1);
    assert.equal(await readFile(join(workspace, "subagent-nested.txt"), "utf8"), "NESTED_WRITE_OK");
    assert.equal(running.prompts.length, 3, "Only the new MCP subject needs an approval");
    const before = childRequests;
    await prompt("Try one more child.", [
      { name: "spawn_agent", args: { task: "This must exceed the total limit." } },
    ]);
    assert.equal(childRequests, before);
    assert.equal((await observe()).total, 2);
    assert.equal(running.prompts.length, 3);
    await toggleSubagents(false);
    assert.equal(
      (await observe()).total,
      2,
      "Disabled delegation keeps existing agents inspectable",
    );
    await running.stop();
    running = undefined;
    console.log(
      "Managed subagents: shared grants, real tools, extension visibility/guidance, previews and spawn quotas passed",
    );
  } finally {
    await running?.stop();
    await writeFile(configPath, originalConfig);
    await writeFile(modelsPath, originalModels);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

function client(child, externalFailure) {
  const messages = [];
  const prompts = [];
  let failure;
  let stderr = "";
  let sequence = 0;
  const ended = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code));
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + chunk).slice(-16000);
  });
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const event = JSON.parse(line);
      messages.push(event);
      assert(event.type !== "extension_error", JSON.stringify(event));
      if (event.type === "extension_ui_request" && event.method === "select") {
        prompts.push(event.title);
        assert(event.options.includes("Allow for session"), JSON.stringify(event));
        child.stdin.write(
          `${JSON.stringify({ type: "extension_ui_response", id: event.id, value: "Allow for session" })}\n`,
        );
      }
    } catch (error) {
      failure ??= error;
    }
  });
  const result = {
    messages,
    prompts,
    async wait(predicate) {
      const deadline = Date.now() + 45000;
      for (;;) {
        if (failure || externalFailure()) throw failure ?? externalFailure();
        const found = predicate();
        if (found) return found;
        assert.equal(child.exitCode, null, `Pi exited: ${stderr}`);
        assert(
          Date.now() < deadline,
          `Timed out: ${stderr}\n${JSON.stringify(messages).slice(-10000)}`,
        );
        await delay(20);
      }
    },
    async request(type, fields = {}) {
      const id = `subagent-rpc-${++sequence}`;
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      const response = await result.wait(() =>
        messages.find((message) => message.type === "response" && message.id === id),
      );
      assert.equal(response.success, true, JSON.stringify(response));
      return response.data;
    },
    async idle() {
      for (let i = 0; i < 100; i++) {
        const state = await result.request("get_state");
        if (!state.isStreaming && !state.pendingMessageCount) return;
        await delay(20);
      }
      throw new Error("Parent did not settle after child notifications");
    },
    async stop() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 10000);
      try {
        assert.equal(await ended, 0, stderr);
      } finally {
        clearTimeout(timer);
      }
    },
  };
  return result;
}
