import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { setTimeout, clearTimeout } from "node:timers";
import { parse, stringify } from "@iarna/toml";
import { prepareWritableSmokeWorkspace } from "./packaged-smoke-config.mjs";

/** Exercise mode admission and real CWD grants through the compiled application, without a provider. */
export async function testWorkspaceModes({ launch, configPath, workspace }) {
  const original = await readFile(configPath, "utf8");
  const target = join(workspace, "workspace-mode-write.txt");
  let active;
  try {
    const config = prepareWritableSmokeWorkspace(parse(original));
    const confined = config.execution.backend !== "direct";
    const policy = (mode) => ({ mode, session_grant: "never" });
    config.tools.bash = policy("ask");
    config.tools.write = policy("ask");
    config.tools.edit = policy("ask");
    config.workspace = {
      default: "host",
      allowed: confined ? ["sandbox", "host"] : ["host"],
      modes: {
        host: { description: "Edit the host project." },
        ...(confined
          ? {
              sandbox: {
                description: "Use temporary files and save deliverables.",
                filesystem: { cwd_writable: false },
                exports: { enabled: true },
                tools: { bash: policy("allow"), write: policy("allow"), edit: policy("allow") },
              },
            }
          : {}),
        restricted: { description: "RESTRICTED_DESCRIPTION_MUST_NOT_APPEAR" },
      },
    };
    const source = stringify(config);
    await writeFile(configPath, source.replace("config_version = 16", "config_version = 14"));
    const obsolete = await collect(launch(["--validate-installation"]));
    assert.notEqual(obsolete.code, 0);
    assert.match(obsolete.stderr, /config_version.*16/);
    config.models_file = "/nonexistent/workspace-list-models.json";
    config.environment.pi.MISSING_SECRET = { file: "/nonexistent/workspace-list-secret" };
    await writeFile(configPath, stringify(config));
    const listed = await collect(launch(["--list-workspace-modes"]));
    assert.equal(listed.code, 0, listed.stderr);
    assert.equal(
      listed.stdout,
      "host (default) — Edit the host project.\n" +
        (confined ? "sandbox — Use temporary files and save deliverables.\n" : ""),
    );
    assert.equal(listed.stderr, "");
    // Operational launches capture the complete snapshot before selecting a mode.
    // Keep missing catalog/secret inputs confined to the policy-only listing check.
    await writeFile(configPath, source);
    const forbidden = await collect(launch(["--workspace-mode=restricted", "--mode", "rpc"]));
    assert.notEqual(forbidden.code, 0);
    assert(
      forbidden.stderr.includes(`Allowed modes: ${confined ? "host, sandbox" : "host"}`),
      forbidden.stderr,
    );
    assert(!forbidden.stderr.includes("RESTRICTED_DESCRIPTION"));

    for (const name of confined ? ["host", "sandbox"] : ["host"]) {
      await writeFile(configPath, source);
      await rm(target, { force: true });
      active = rpc(
        launch([...(name === "host" ? [] : ["--workspace-mode", name]), "--mode", "rpc"]),
      );
      await active.request("get_state");
      const summary = await active.diagnostic("/sandbox");
      assert.match(summary, new RegExp(`Workspace mode:\\s+${name}`));
      assert.match(
        summary,
        new RegExp(`Mode selection:\\s+${name === "host" ? "default" : "CLI"}`),
      );
      assert(
        summary.includes(
          name === "host" ? "Edit the host project." : "Use temporary files and save deliverables.",
        ),
      );
      assert.match(
        summary,
        new RegExp(`File exports:\\s+${name === "host" ? "disabled" : "enabled \\(TUI-only\\)"}`),
      );
      const policies = await active.diagnostic("/sandbox policy");
      assert.match(
        policies,
        new RegExp(`write\\s+[^\\n]*\\b${name === "host" ? "ask" : "allow"}\\b`),
      );
      const command = `printf MODE_WRITE > '${target.replaceAll("'", "'\\''")}'`;
      const result = await active.request("bash", { command });
      if (name === "host") {
        assert.equal(result.data.exitCode, 0, JSON.stringify(result));
        assert.equal(await readFile(target, "utf8"), "MODE_WRITE");
      } else {
        assert.notEqual(result.data.exitCode, 0, "read-only mode must reject real host CWD writes");
        await assert.rejects(readFile(target), { code: "ENOENT" });
        // Changing the file and replacing the conversation cannot replace this process's mode.
        await writeFile(configPath, original);
        await active.request("new_session");
        assert.match(await active.diagnostic("/sandbox"), /Workspace mode:\s+sandbox/);
        const again = await active.request("bash", { command });
        assert.notEqual(again.data.exitCode, 0);
      }
      await active.close();
      active = undefined;
    }
    console.log(
      "Workspace modes: filtered listing, explicit/default selection, policy, CWD grants and session reuse passed",
    );
  } finally {
    await active?.close();
    await writeFile(configPath, original);
    await rm(target, { force: true });
  }
}

function collect(child) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("workspace listing timed out"));
    }, 20000);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function rpc(child) {
  const messages = [];
  let stderr = "";
  let failure;
  let sequence = 0;
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.on("error", (error) => {
    failure = error;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      messages.push(JSON.parse(line));
    } catch {
      failure = new Error(`non-JSON RPC output: ${line}`);
    }
  });
  async function waitFor(predicate) {
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      const value = predicate();
      if (value) return value;
      if (child.exitCode !== null || child.signalCode !== null)
        throw new Error(`workspace RPC exited: ${stderr}`);
      await delay(20);
    }
    throw new Error(`workspace RPC timed out: ${stderr}`);
  }
  async function request(type, fields = {}) {
    const id = `workspace-${++sequence}`;
    child.stdin.write(JSON.stringify({ id, type, ...fields }) + "\n");
    const response = await waitFor(() =>
      messages.find((message) => message.id === id && message.type === "response"),
    );
    assert.equal(response.success, true, JSON.stringify(response));
    return response;
  }
  return {
    request,
    async diagnostic(command) {
      const start = messages.length;
      await request("prompt", { message: command });
      return (
        await waitFor(() =>
          messages
            .slice(start)
            .find(
              (message) => message.type === "extension_ui_request" && message.method === "notify",
            ),
        )
      ).message;
    },
    async close() {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = new Promise((resolve) => child.once("close", resolve));
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
        await closed;
        clearTimeout(timer);
      }
      lines.close();
    },
  };
}
