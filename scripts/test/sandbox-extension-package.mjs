import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
execFileSync(process.execPath, [join(root, "scripts/build-sandbox-extension.mjs")], {
  stdio: "inherit",
});
const temp = await mkdtemp("/var/tmp/pi-extension-package-");
const children = new Set();
try {
  const packed = JSON.parse(
    execFileSync(
      "npm",
      ["pack", join(root, "packages/sandbox-extension"), "--pack-destination", temp, "--json"],
      { encoding: "utf8" },
    ),
  )[0];
  const archive = join(temp, packed.filename);
  const entries = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" }).trim().split("\n");
  for (const required of [
    "package/dist/index.js",
    "package/dist/factory.js",
    "package/dist/runtime/worker-entry.js",
    "package/LICENSE",
    "package/provenance.json",
  ])
    assert(entries.includes(required), required);
  assert(
    entries.every(
      (name) =>
        name.startsWith("package/") &&
        !name.includes("../") &&
        !name.includes("node_modules/") &&
        !name.endsWith(".test.js"),
    ),
  );
  execFileSync("tar", ["-xzf", archive, "-C", temp]);
  // Only the public peer dependency installation is shared with this fixture.
  await symlink(join(root, "node_modules"), join(temp, "node_modules"), "dir");
  const metadata = JSON.parse(await readFile(join(temp, "package/package.json"), "utf8"));
  assert.equal(metadata.peerDependencies["@earendil-works/pi-coding-agent"], "1.1.0");
  for (const entry of Object.values(metadata.exports))
    await import(pathToFileURL(join(temp, "package", entry)).href);
  const provenance = JSON.parse(await readFile(join(temp, "package/provenance.json"), "utf8"));
  assert.equal(
    provenance.sourceCommit,
    execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  );
  assert.equal(provenance.piVersion, "1.1.0");
  if (process.platform !== "linux")
    throw new Error("This package acceptance requires Linux Bubblewrap");
  const runtimes = [process.execPath, execFileSync("which", ["bun"], { encoding: "utf8" }).trim()];
  for (const [index, runtime] of runtimes.entries()) {
    const workspace = join(temp, `workspace-${index}`);
    const home = join(temp, `home-${index}`);
    await mkdir(workspace);
    await mkdir(home);
    const config = join(temp, `config-${index}.json`);
    await writeFile(
      config,
      JSON.stringify({
        version: 1,
        mode: "owned",
        backend: {
          kind: "bubblewrap",
          executable: "/usr/bin/bwrap",
          runtime,
          network: "local",
          processLifetime: "sandbox",
          cwdWritable: true,
          hiddenPaths: [home],
          environment: {},
        },
        tools: {
          read: { mode: "allow", sessionGrant: "never" },
          bash: { mode: "allow", sessionGrant: "never" },
        },
        userBash: true,
      }),
      { mode: 0o600 },
    );
    const child = spawn(
      process.execPath,
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
        join(temp, "package/dist/index.js"),
        "--sandbox-config",
        config,
      ],
      {
        cwd: workspace,
        env: {
          PATH: process.env.PATH,
          HOME: home,
          PI_CODING_AGENT_DIR: join(home, "agent"),
          NO_COLOR: "1",
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
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
      for (let count = 0; count < 400; count++) {
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
    const write = await request("bash", { command: "printf package-ok > result.txt" });
    assert.equal(write.data.exitCode, 0);
    assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "package-ok");
    child.stdin.end();
    for (let count = 0; child.exitCode === null && count < 400; count++) await delay(25);
    assert.equal(child.exitCode, 0, errors);
    assert(
      !messages.some((message) => message.type === "extension_error"),
      JSON.stringify(messages),
    );
    children.delete(child);
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
