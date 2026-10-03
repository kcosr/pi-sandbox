import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Offline checks against the real packaged executable, using the caller's isolated RPC launch. */
export async function testRpcSessionLifecycle({ child, messages, waitFor, workspace }) {
  let sequence = 0;
  async function request(type, fields = {}, success = true) {
    const id = `lifecycle-${++sequence}`;
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    const response = await waitFor(
      () => messages.find((message) => message.id === id && message.type === "response"),
      `${type} lifecycle response`,
    );
    assert.equal(response.success, success, JSON.stringify(response));
    return response;
  }
  async function checkWorkspace() {
    const before = messages.length;
    await request("prompt", { message: "/sandbox" });
    assert(
      messages
        .slice(before)
        .some(
          (message) =>
            message.type === "extension_ui_request" &&
            message.method === "notify" &&
            message.message.includes("Pi Sandbox: initialized") &&
            message.message.includes(workspace),
        ),
      "fresh runtime must initialize the mandatory Sandbox extension",
    );
    const shell = await request("bash", { command: "pwd" });
    assert.equal(shell.data.exitCode, 0, JSON.stringify(shell));
    assert.equal(shell.data.output.trim(), workspace);
  }

  const initial = (await request("get_state")).data.sessionId;
  await request("new_session");
  assert.notEqual((await request("get_state")).data.sessionId, initial);
  await checkWorkspace();
  await request("new_session");
  await checkWorkspace();

  const sessionId = randomUUID();
  const timestamp = new Date().toISOString();
  const entries = [
    { type: "session", version: 3, id: sessionId, timestamp, cwd: workspace },
    {
      type: "message",
      id: "11111111",
      parentId: null,
      timestamp,
      message: { role: "user", content: "offline persisted fixture", timestamp: Date.now() },
    },
    {
      type: "message",
      id: "22222222",
      parentId: "11111111",
      timestamp,
      message: {
        role: "assistant",
        content: [{ type: "text", text: "fixture answer" }],
        api: "openai-completions",
        provider: "fixture",
        model: "fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
  ];
  const serialize = (value) => value.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  const sessionPath = join(workspace, "resume.jsonl");
  await writeFile(sessionPath, serialize(entries));
  await request("switch_session", { sessionPath });
  assert.equal((await request("get_state")).data.sessionId, sessionId);
  await checkWorkspace();
  await request("clone");
  assert.notEqual((await request("get_state")).data.sessionId, sessionId);
  await checkWorkspace();
  await request("switch_session", { sessionPath });
  await request("fork", { entryId: "11111111" });
  await checkWorkspace();

  const foreign = join(workspace, "foreign");
  await mkdir(join(foreign, ".pi"), { recursive: true });
  await writeFile(join(foreign, "AGENTS.md"), "FOREIGN_CONTEXT_MUST_NOT_LOAD");
  await writeFile(join(foreign, ".pi", "settings.json"), '{"defaultProvider":"foreign"}');
  const foreignPath = join(workspace, "foreign.jsonl");
  await writeFile(foreignPath, serialize([{ ...entries[0], id: randomUUID(), cwd: foreign }]));
  const beforeReject = (await request("get_state")).data.sessionId;
  const rejected = await request("switch_session", { sessionPath: foreignPath }, false);
  assert.match(rejected.error, /session CWD must match the launch workspace/);
  assert.equal((await request("get_state")).data.sessionId, beforeReject);
  await checkWorkspace();
  assert.deepEqual(
    messages.filter((message) => message.type === "extension_error"),
    [],
  );
}
