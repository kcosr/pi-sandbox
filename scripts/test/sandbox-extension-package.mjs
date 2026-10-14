import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, realpath, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { testParallelTools } from "./parallel-tools-smoke.mjs";
import { installExtensionArtifacts } from "./extension-artifacts.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const buildArgs = process.argv.slice(2);
if (
  buildArgs.length !== 0 &&
  (buildArgs.length !== 2 || buildArgs[0] !== "--distribution" || !buildArgs[1])
)
  throw new Error("usage: node scripts/test/sandbox-extension-package.mjs [--distribution FILE]");
execFileSync(process.execPath, [join(root, "scripts/build-extensions.mjs"), ...buildArgs], {
  stdio: "inherit",
});
const temp = await realpath(
  await mkdtemp(join(process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp", "pie-")),
);
const children = new Set();
try {
  const artifacts = await installExtensionArtifacts(root, temp, ["sandbox-extension"]);
  const packed = artifacts["sandbox-extension"];
  const archive = packed.archive;
  if (!["linux", "darwin"].includes(process.platform))
    throw new Error("Unsupported package test host");
  const runtimes = [
    process.execPath,
    process.env.PI_SANDBOX_BUN ?? execFileSync("which", ["bun"], { encoding: "utf8" }).trim(),
  ];
  const cases = [
    ...(process.platform === "linux"
      ? runtimes.map((runtime) => ({ kind: "bubblewrap", runtime, piRuntime: process.execPath }))
      : runtimes.map((piRuntime) => ({ kind: "seatbelt", piRuntime }))),
    ...runtimes.map((piRuntime) => ({ kind: "direct", piRuntime })),
  ];
  for (const [index, selected] of cases.entries()) {
    const { runtime } = selected;
    const workspace = join(temp, `workspace-${index}`);
    const home = join(temp, `home-${index}`);
    await mkdir(workspace);
    await mkdir(home);
    const config = join(temp, `config-${index}.json`);
    const backend =
      selected.kind === "bubblewrap"
        ? {
            kind: "bubblewrap",
            executable: "/usr/bin/bwrap",
            runtime,
            network: "local",
            cwdWritable: true,
            hiddenPaths: [home],
            environment: {},
          }
        : selected.kind === "seatbelt"
          ? {
              kind: "seatbelt",
              network: "none",
              cwdWritable: true,
              deniedPaths: [home],
              environment: {},
            }
          : { kind: "direct", environment: {} };
    await writeFile(
      config,
      JSON.stringify({
        version: 6,
        mode: "owned",
        backend,
        userBash: true,
      }),
      { mode: 0o600 },
    );
    const launch = (args = []) =>
      spawn(
        selected.piRuntime,
        [
          join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
          "--mode",
          "rpc",
          "--no-builtin-tools",
          "--no-extensions",
          "--no-skills",
          "--no-prompt-templates",
          "--no-context-files",
          "--no-themes",
          "-e",
          join(packed.directory, "dist/index.js"),
          "--sandbox-config",
          config,
          ...args,
        ],
        {
          cwd: workspace,
          env: {
            PATH: process.env.PATH,
            HOME: home,
            XDG_DATA_HOME: join(home, "data"),
            XDG_CACHE_HOME: join(home, "cache"),
            PI_CODING_AGENT_DIR: join(home, "agent"),
            NO_COLOR: "1",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
    const child = launch();
    children.add(child);
    let output = "",
      errors = "",
      pending = "";
    const messages = [];
    child.stdout.on("data", (chunk) => {
      output += chunk;
      pending += chunk;
      for (;;) {
        const newline = pending.indexOf("\n");
        if (newline < 0) break;
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        try {
          messages.push(JSON.parse(line));
        } catch {
          // Non-RPC diagnostics are retained in output for failure reporting.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      errors += chunk;
    });
    let sequence = 0;
    async function request(type, fields = {}) {
      const id = `package-${++sequence}`;
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      for (let count = 0; count < 1200; count++) {
        const response = messages.find((message) => message.id === id);
        if (response) {
          assert.equal(response.success, true, JSON.stringify(response));
          return response;
        }
        if (child.exitCode !== null) throw new Error(`Pi exited: ${errors}\n${output}`);
        await delay(25);
      }
      throw new Error(`No ${type} response: ${errors}\n${output}`);
    }
    await request("get_state");
    if (selected.kind === "bubblewrap") {
      const first = await request("bash", { command: "readlink /proc/self/ns/pid" });
      assert.equal(first.data.exitCode, 0, JSON.stringify(first));
      await request("bash", { command: "sleep 60 >background.log 2>&1 & echo $! >background.pid" });
      await request("new_session");
      const second = await request("bash", {
        command: 'kill -0 "$(cat background.pid)" && readlink /proc/self/ns/pid',
      });
      assert.equal(second.data.exitCode, 0, JSON.stringify(second) + errors);
      assert.equal(
        second.data.output,
        first.data.output,
        "conversation replacement must reuse the namespace",
      );
    } else await request("new_session");
    const write = await request("bash", { command: "printf package-ok > result.txt" });
    assert.equal(write.data.exitCode, 0);
    assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "package-ok");
    child.stdin.end();
    for (let count = 0; child.exitCode === null && count < 1200; count++) await delay(25);
    assert.equal(child.exitCode, 0, errors);
    assert(
      !messages.some((message) => message.type === "extension_error"),
      JSON.stringify(messages),
    );
    children.delete(child);
    await testParallelTools({
      launch: (args) => launch(["-e", "builtin:codemode", ...args]),
      modelsPath: join(home, "agent/models.json"),
      workspace,
    });
    console.log(`PASS ${selected.kind} ordinary Pi under ${selected.piRuntime}`);
  }
  console.log(
    `Inspected and exercised ${packed.filename}; SHA256 ${createHash("sha256")
      .update(await readFile(archive))
      .digest("hex")}`,
  );
} finally {
  for (const child of children) {
    child.stdin.destroy();
    child.kill("SIGKILL");
  }
  await rm(temp, { recursive: true, force: true });
}
