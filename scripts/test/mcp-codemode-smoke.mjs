import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { setTimeout, clearTimeout } from "node:timers";
import { URL } from "node:url";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";

const toolPolicy = (mode) => ({ mode, session_grant: "never", audit: false });
const schema = { type: "object", properties: {}, additionalProperties: true };
const httpTools = ["search_allowed", "mutate_record", "delete_record", "hidden_secret"].map(
  (name) => ({
    name,
    description: `Offline smoke ${name}`,
    inputSchema: schema,
  }),
);
const script = `
text(await tools.read({path:"input.txt"}));
await tools.write({path:"written.txt",content:"approved nested write"});
text(await tools.bash({command:"printf smoke-bash"}));
text(await tools.mcp__docs__search_allowed({query:"smoke"}));
text(await tools.mcp__docs__mutate_record({value:"approved"}));
try { await tools.mcp__docs__delete_record({}); text("DENIAL_BYPASSED"); }
catch { text("EXPECTED_POLICY_DENIAL"); }
const localResult = await tools.mcp__local__environment({});
text(localResult);
if(JSON.parse(localResult.content.find(c=>c.type==="text").text).providerSecret) throw new Error("ambient credential inherited");
text("STDIO_CREDENTIAL_BOUNDARY_OK");
if(ALL_TOOLS.some(t=>t.name==="mcp__docs__hidden_secret") || typeof models!=="undefined") throw new Error("disabled feature exposed");
text("FEATURE_SURFACE_OK");
`;

/** Real packaged Pi, local scripted provider, and both real transports; no external services. */
export async function testManagedMcpCodemode({
  launch,
  configPath,
  modelsPath,
  workspace,
  userState,
  username,
  uid,
}) {
  const httpPath = "/mcp/shared?tenant=shared%2Bteam&literal=a%2fb&tag=one&tag=two";
  const receivedHttp = [];
  const providerRequests = [];
  const prompts = [];
  const pidLog = join(workspace, "stdio-pids.jsonl");
  const serverScript = join(workspace, "stdio-server.mjs");
  await writeFile(serverScript, stdioFixture());
  await writeFile(join(workspace, "input.txt"), "nested-read-marker");
  const counts = new Map();
  let serverFailure;
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://localhost");
      if (url.pathname === "/v1/chat/completions") {
        const body = await jsonBody(request);
        providerRequests.push(body);
        const lastUser = [...body.messages].reverse().find((message) => message.role === "user");
        const marker = JSON.stringify(lastUser).includes("MCP_DISABLED_SMOKE")
          ? "disabled"
          : "enabled";
        const count = counts.get(marker) ?? 0;
        counts.set(marker, count + 1);
        const tools = body.tools ?? [];
        const names = tools.map((tool) => tool.function?.name ?? tool.custom?.name);
        response.writeHead(200, { "content-type": "text/event-stream" });
        const chunk = (delta, finishReason = null) =>
          response.write(
            `data: ${JSON.stringify({
              id: `smoke-${providerRequests.length}`,
              object: "chat.completion.chunk",
              created: 1,
              model: "fixture",
              choices: [{ index: 0, delta, finish_reason: finishReason }],
            })}\n\n`,
          );
        if (marker === "enabled" && count === 0) {
          assert(
            names.includes("codemode"),
            "enabled code mode must be exposed in the actual provider request",
          );
          assert(
            !names.includes("mcp__docs__hidden_secret"),
            "disabled MCP tool must not reach provider",
          );
          const code = tools.find(
            (tool) => (tool.function?.name ?? tool.custom?.name) === "codemode",
          );
          chunk({
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "smoke-code-1",
                type: code.type,
                ...(code.type === "custom"
                  ? { custom: { name: "codemode", input: script } }
                  : {
                      function: { name: "codemode", arguments: JSON.stringify({ code: script }) },
                    }),
              },
            ],
          });
          chunk({}, "tool_calls");
        } else {
          if (marker === "disabled")
            assert(
              names.every((name) => name !== "codemode" && !name?.startsWith("mcp__")),
              "user settings must not enable managed features",
            );
          chunk({ role: "assistant", content: `SMOKE_${marker.toUpperCase()}_DONE` });
          chunk({}, "stop");
        }
        response.end("data: [DONE]\n\n");
        return;
      }
      receivedHttp.push({
        method: request.method,
        url: request.url,
        authorization: request.headers.authorization,
      });
      assert.equal(url.pathname, "/mcp/shared");
      assert.equal(url.searchParams.get("tenant"), "shared+team");
      assert.equal(url.searchParams.get("literal"), "a/b");
      assert.deepEqual(url.searchParams.getAll("tag"), ["one", "two"]);
      assert.equal(
        request.url,
        httpPath,
        "literal query ordering, repeated parameters, and percent escapes must not be rewritten",
      );
      assert.equal(request.headers.authorization, "Bearer http-specific");
      if (request.method === "GET") {
        response.writeHead(405).end();
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(200).end();
        return;
      }
      assert.equal(request.method, "POST");
      const body = await jsonBody(request);
      receivedHttp.at(-1).rpc = body.method;
      if (body.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      let result;
      if (body.method === "initialize")
        result = {
          protocolVersion: "2025-11-25",
          capabilities: { tools: {} },
          serverInfo: { name: "offline-http", version: "1" },
        };
      else if (body.method === "tools/list") result = { tools: httpTools };
      else if (body.method === "tools/call") {
        receivedHttp.at(-1).tool = body.params.name;
        assert(
          ["search_allowed", "mutate_record"].includes(body.params.name),
          "denied/disabled tools must never dispatch",
        );
        result = { content: [{ type: "text", text: `HTTP_${body.params.name}_OK` }] };
      } else throw new Error(`Unexpected MCP request ${body.method}`);
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "smoke-session",
      });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    } catch (error) {
      serverFailure ??= error;
      if (!response.headersSent) response.writeHead(500);
      response.end();
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  let running;
  try {
    const config = parseToml(await readFile(configPath, "utf8"));
    config.audit.enabled = false;
    config.sessions.retention_days = 0;
    config.codemode = { enabled: true, timeout_ms: 30000 };
    config.tools.write = toolPolicy("ask");
    config.tools.bash = toolPolicy("ask");
    config.tools.read = toolPolicy("allow");
    config.environment.pi.DOCS_AUTHORIZATION = "Bearer http-specific";
    config.environment.pi.LOCAL_TOKEN = "stdio-specific";
    config.environment.pi.PROVIDER_SECRET = "must-not-reach-stdio";
    config.mcp = {
      servers: {
        docs: {
          enabled: true,
          transport: "http",
          url: `http://127.0.0.1:${port}${httpPath}`,
          exposure: "direct",
          headers_from_env: { Authorization: "DOCS_AUTHORIZATION" },
          default_policy: toolPolicy("disabled"),
          tool_rules: [
            { match: "search_allowed", ...toolPolicy("allow") },
            { match: "search_*", ...toolPolicy("deny") },
            { match: "mutate_*", ...toolPolicy("ask") },
            { match: "delete_*", ...toolPolicy("deny") },
          ],
        },
        local: {
          enabled: true,
          transport: "stdio",
          command: process.execPath,
          args: [serverScript],
          exposure: "codemode",
          env: { PID_LOG: pidLog, ACCOUNT_TAG: "{{username}}/{{uid}}" },
          env_from_env: { SERVICE_TOKEN: "LOCAL_TOKEN" },
          default_policy: toolPolicy("allow"),
        },
      },
    };
    await writeFile(configPath, stringifyToml(config));
    await writeFile(
      modelsPath,
      JSON.stringify({
        providers: {
          fixture: {
            baseUrl: `http://127.0.0.1:${port}/v1`,
            api: "openai-completions",
            apiKey: "offline-placeholder",
            authHeader: false,
            compat: { supportsDeveloperRole: false, supportsReasoningEffort: false },
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
    );
    await mkdir(join(workspace, ".pi"), { recursive: true });
    const rogue = JSON.stringify({
      mcpServers: { rogue: { url: `http://127.0.0.1:${port}/rogue` } },
    });
    await writeFile(join(userState, "mcp.json"), rogue);
    await writeFile(join(workspace, ".pi", "mcp.json"), rogue);
    running = rpc(launch(["--provider", "fixture", "--model", "fixture"]), () => serverFailure);
    running.onSelect = async (message) => {
      prompts.push(message.title);
      if (message.title.startsWith("Allow write:"))
        await assert.rejects(access(join(workspace, "written.txt")), { code: "ENOENT" });
      assert(message.options.includes("Allow once"));
      return "Allow once";
    };
    await running.request("get_state");
    await running.request("prompt", { message: "MCP_ENABLED_SMOKE" });
    await running.wait(
      () => running.messages.find((message) => message.type === "agent_end"),
      "script agent_end",
    );
    if (serverFailure) throw serverFailure;
    const codeResult = running.messages.find(
      (message) => message.type === "tool_execution_end" && message.toolName === "codemode",
    );
    assert(
      codeResult,
      `actual code-mode result must be emitted: ${JSON.stringify(running.messages).slice(-8000)}`,
    );
    assert.equal(codeResult.isError, false, JSON.stringify(codeResult));
    assert.equal(await readFile(join(workspace, "written.txt"), "utf8"), "approved nested write");
    assert.deepEqual(
      prompts.map((title) => title.split(":")[0]),
      ["Allow write", "Allow bash", "Allow docs/mutate_record"],
    );
    const content = JSON.stringify(codeResult.result);
    for (const expected of [
      "nested-read-marker",
      "smoke-bash",
      "HTTP_search_allowed_OK",
      "HTTP_mutate_record_OK",
      "EXPECTED_POLICY_DENIAL",
      "stdio-specific",
      "STDIO_CREDENTIAL_BOUNDARY_OK",
      "FEATURE_SURFACE_OK",
      `${username}/${uid}`,
      workspace,
      dirname(userState),
    ])
      assert(content.includes(expected), `missing nested result ${expected}: ${content}`);
    assert(!content.includes("DENIAL_BYPASSED"));
    const firstPids = await readPids(pidLog);
    assert(firstPids.length >= 2, "stdio fixture and descendant must start");
    await running.request("new_session");
    await running.wait(
      () => (firstPids.every(gone) ? true : undefined),
      "outgoing stdio process group reaped",
    );
    await running.stop();
    running = undefined;
    await eventually(
      async () => (await readPids(pidLog)).every(gone),
      "stdio process groups on shutdown",
    );
    assert(
      receivedHttp.some((request) => request.method === "POST" && request.rpc === "tools/call"),
    );
    assert(
      receivedHttp.some((request) => request.method === "GET"),
      "background GET must preserve query",
    );
    assert(
      receivedHttp.some((request) => request.method === "DELETE"),
      "session DELETE must preserve query",
    );

    config.codemode.enabled = false;
    for (const server of Object.values(config.mcp.servers)) server.enabled = false;
    config.mcp.servers.local.command = "/missing/disabled-mcp-server";
    await writeFile(configPath, stringifyToml(config));
    await writeFile(
      join(userState, "settings.json"),
      JSON.stringify({ defaultTools: ["codemode"], codemode: { mode: "only" } }),
    );
    const before = receivedHttp.length;
    const pidsBefore = await readPids(pidLog);
    running = rpc(launch(["--provider", "fixture", "--model", "fixture"]), () => serverFailure);
    await running.request("get_state");
    await running.request("prompt", { message: "MCP_DISABLED_SMOKE" });
    await running.wait(
      () => running.messages.find((message) => message.type === "agent_end"),
      "disabled features agent_end",
    );
    await running.stop();
    running = undefined;
    assert.equal(
      receivedHttp.length,
      before,
      "disabled and user-configured servers must not connect",
    );
    assert.deepEqual(await readPids(pidLog), pidsBefore, "disabled stdio must not start");
    assert(
      providerRequests.some((body) => JSON.stringify(body.messages).includes("MCP_DISABLED_SMOKE")),
    );
    if (serverFailure) throw serverFailure;
  } finally {
    await running?.stop().catch(() => undefined);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function jsonBody(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}
function gone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
}
async function readPids(path) {
  return (await readFile(path, "utf8"))
    .trim()
    .split("\n")
    .flatMap((line) => JSON.parse(line));
}
async function eventually(predicate, label) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(20);
  }
  throw new Error(`Timed out: ${label}`);
}
function rpc(child, externalFailure) {
  const messages = [];
  let stderr = "";
  let failure;
  let sequence = 0;
  const ended = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const client = {
    messages,
    onSelect: undefined,
    async wait(predicate, label) {
      let result;
      await eventually(() => {
        if (failure || externalFailure()) throw failure ?? externalFailure();
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Pi exited before ${label}: ${stderr}`);
        result = predicate();
        return result !== undefined;
      }, label);
      return result;
    },
    async request(type, fields = {}) {
      const id = `feature-${++sequence}`;
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      const response = await client.wait(
        () => messages.find((message) => message.type === "response" && message.id === id),
        type,
      );
      assert.equal(response.success, true, JSON.stringify(response));
      return response;
    },
    async stop() {
      child.stdin.end();
      const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
      try {
        const exit = await ended;
        assert.equal(exit.code, 0, `Pi failed: ${exit.signal ?? stderr}`);
        assert(
          !messages.some((message) => message.type === "extension_error"),
          JSON.stringify(messages),
        );
      } finally {
        clearTimeout(timer);
      }
    },
  };
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const message = JSON.parse(line);
      messages.push(message);
      if (message.type === "extension_ui_request" && message.method === "select") {
        Promise.resolve(client.onSelect?.(message) ?? "Deny")
          .then((value) =>
            child.stdin.write(
              `${JSON.stringify({ type: "extension_ui_response", id: message.id, value })}\n`,
            ),
          )
          .catch((error) => {
            failure = error;
          });
      }
    } catch {
      failure = new Error(`Invalid RPC JSON: ${line}`);
    }
  });
  return client;
}
function stdioFixture() {
  return `import {appendFileSync} from 'node:fs';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
const child = spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
appendFileSync(process.env.PID_LOG,JSON.stringify([process.pid,child.pid])+'\\n');
createInterface({input:process.stdin}).on('line',line=>{
 const req=JSON.parse(line); if(req.id===undefined)return;
 let result;
 if(req.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'offline-stdio',version:'1'}};
 else if(req.method==='tools/list')result={tools:[{name:'environment',description:'Report projected environment',inputSchema:{type:'object',properties:{}}}]};
 else if(req.method==='tools/call')result={content:[{type:'text',text:JSON.stringify({token:process.env.SERVICE_TOKEN,account:process.env.ACCOUNT_TAG,providerSecret:process.env.PROVIDER_SECRET!==undefined,cwd:process.cwd(),home:process.env.HOME,user:process.env.USER})}]};
 else throw new Error('unexpected '+req.method);
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:req.id,result})+'\\n');
});
process.stdin.on('end',()=>process.exit(0));
`;
}
