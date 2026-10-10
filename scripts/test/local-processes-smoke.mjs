import assert from "node:assert/strict";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";

/** Exercise TOML -> compiled executor wiring through real RPC shell calls, without a provider. */
export async function testLocalProcessLifetime({ launch, configPath, workspace }) {
  const original = await readFile(configPath, "utf8");
  const config = parseToml(original);
  if (config.execution.backend !== "bubblewrap") return;
  config.network.mode = "local";
  config.execution.process_lifetime = "sandbox";
  config.filesystem.cwd_writable = true;
  const scriptPath = join(workspace, "packaged-local-server.py");
  const portPath = join(workspace, "packaged-local-port");
  await writeFile(
    scriptPath,
    `
from http.server import BaseHTTPRequestHandler, HTTPServer
class Handler(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'packaged-local-server')
server = HTTPServer(('127.0.0.1', 0), Handler)
with open(${JSON.stringify(portPath)}, 'w') as output:
    output.write(str(server.server_port))
server.serve_forever()
`,
  );

  let child;
  let exited;
  let lines;
  let failure;
  let stderr = "";
  try {
    await writeFile(configPath, stringifyToml(config));
    child = launch();
    exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    void exited.catch((error) => {
      failure = error;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const messages = [];
    lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        messages.push(JSON.parse(line));
      } catch {
        failure = new Error(`Invalid local-process RPC output: ${line}`);
      }
    });
    let sequence = 0;
    async function request(type, fields = {}) {
      const id = `local-process-${++sequence}`;
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      const response = await waitFor(async () => {
        if (failure) throw failure;
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`Local-process Pi exited early: ${stderr}`);
        }
        return messages.find((message) => message.id === id && message.type === "response");
      }, `${type} RPC response`);
      assert.equal(response.success, true, JSON.stringify(response));
      return response;
    }
    await request("get_state");
    const start = await request("bash", {
      command: `/usr/bin/python3 ${shellQuote(scriptPath)} > ${shellQuote(join(workspace, "packaged-local-server.log"))} 2>&1 < /dev/null &`,
    });
    assert.equal(start.data.exitCode, 0, JSON.stringify(start));
    const port = await waitFor(async () => {
      const content = await readFile(portPath, "utf8").catch(() => "");
      return /^\d+$/.test(content) ? Number(content) : undefined;
    }, "background HTTP server readiness");
    const response = await request("bash", {
      command: `/usr/bin/curl --silent --show-error --fail --noproxy '*' --max-time 2 http://localhost:${port}/`,
    });
    assert.equal(response.data.exitCode, 0, JSON.stringify(response));
    assert.equal(response.data.output, "packaged-local-server");
    const pids = [];
    for (const name of await readdir("/proc")) {
      if (!/^\d+$/.test(name)) continue;
      if (await isServerProcess(name, scriptPath)) pids.push(name);
    }
    assert.equal(pids.length, 1, "the packaged sandbox must retain exactly one HTTP server");
    child.stdin.end();
    const exit = await boundedExit(exited);
    assert.equal(exit.code, 0, `Local-process Pi shutdown: ${stderr}`);
    await waitFor(
      async () => !(await isServerProcess(pids[0], scriptPath)) || undefined,
      "background server termination after Pi exit",
    );
    assert.deepEqual(
      messages.filter((message) => message.type === "extension_error"),
      [],
    );
  } finally {
    lines?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await boundedExit(exited).catch(() => undefined);
    }
    await writeFile(configPath, original);
  }
}

async function isServerProcess(pid, scriptPath) {
  const command = await readFile(`/proc/${pid}/cmdline`, "utf8").catch(() => "");
  return command.split("\0").includes(scriptPath);
}

async function waitFor(predicate, label) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result !== undefined) return result;
    await delay(20);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function boundedExit(exited) {
  let timer;
  try {
    return await Promise.race([
      exited,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error("Local-process Pi shutdown timed out")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
