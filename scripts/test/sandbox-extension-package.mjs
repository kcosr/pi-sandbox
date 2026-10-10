import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { testParallelTools } from "./parallel-tools-smoke.mjs";

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
execFileSync(process.execPath, [join(root, "scripts/build-sandbox-extension.mjs")], {
  stdio: "inherit",
});
const temp = await mkdtemp("/var/tmp/pie-");
const children = new Set();
const vmStates = [];
const families = [];
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
  const cases = runtimes.map((runtime) => ({ kind: "bubblewrap", runtime }));
  if (
    process.env.PI_SANDBOX_SMOLVM_BIN &&
    process.env.PI_SANDBOX_SMOLVM_IMAGE &&
    process.env.PI_SANDBOX_SMOLVM_IMAGE_SHA256
  )
    cases.push({ kind: "smolvm", runtime: process.env.PI_SANDBOX_SMOLVM_BIN });
  else if (process.env.PI_SANDBOX_REQUIRE_SMOLVM === "1")
    throw new Error("Required package VM fixture needs runtime, image and digest");
  if (
    process.env.PI_SANDBOX_SMOLVM_BIN &&
    process.env.PI_SANDBOX_SMOLVM_OCI_IMAGE &&
    process.env.PI_SANDBOX_SMOLVM_OCI_SHA256
  )
    cases.push({ kind: "attached", runtime: process.env.PI_SANDBOX_SMOLVM_BIN });
  else if (process.env.PI_SANDBOX_REQUIRE_SMOLVM === "1")
    throw new Error("Required package attachment fixture needs OCI image and digest");
  const { createSmolvmOciFamily } = await import(
    pathToFileURL(join(temp, "package/dist/controller.js")).href
  );
  for (const [index, selected] of cases.entries()) {
    const { runtime } = selected;
    const workspace = join(temp, `workspace-${index}`);
    const home = join(temp, `home-${index}`);
    await mkdir(workspace);
    await mkdir(home);
    const config = join(temp, `config-${index}.json`);
    const stateDirectory = join(temp, `state-${index}`);
    await mkdir(stateDirectory, { mode: 0o700 });
    if (selected.kind !== "bubblewrap") vmStates.push(stateDirectory);
    let family;
    if (selected.kind === "attached") {
      family = await createSmolvmOciFamily({
        smolvmPath: runtime,
        imageArchive: process.env.PI_SANDBOX_SMOLVM_OCI_IMAGE,
        imageSha256: process.env.PI_SANDBOX_SMOLVM_OCI_SHA256,
        stateDirectory,
        cwd: "/workspace",
        networkMode: "none",
        resources: { cpus: 1, memoryMiB: 512, storageGiB: 1, overlayGiB: 1 },
      });
      families.push(family);
    }
    const backend =
      selected.kind === "smolvm"
        ? {
            kind: "smolvm",
            executable: runtime,
            image: process.env.PI_SANDBOX_SMOLVM_IMAGE,
            imageSha256: process.env.PI_SANDBOX_SMOLVM_IMAGE_SHA256,
            stateDirectory,
            resources: { cpus: 1, memoryMiB: 512, storageGiB: 1, overlayGiB: 1 },
            cwdWritable: true,
            environment: {},
          }
        : {
            kind: "bubblewrap",
            executable: "/usr/bin/bwrap",
            runtime,
            network: "local",
            processLifetime: "sandbox",
            cwdWritable: true,
            hiddenPaths: [home],
            environment: {},
          };
    await writeFile(
      config,
      JSON.stringify({
        version: 2,
        ...(family
          ? { mode: "attached", attachment: family.attachment(family.sourceId) }
          : { mode: "owned", backend }),
        tools: {
          read: { mode: "allow", sessionGrant: "never" },
          bash: { mode: "allow", sessionGrant: "never" },
          write: { mode: "allow", sessionGrant: "never" },
          edit: { mode: "allow", sessionGrant: "never" },
        },
        userBash: true,
      }),
      { mode: 0o600 },
    );
    const launch = (args = []) =>
      spawn(
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
          ...args,
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
    if (family) {
      const result = await family.execute(family.sourceId, {
        argv: ["/bin/cat", "/workspace/result.txt"],
      });
      assert.equal(result.stdout.toString(), "package-ok");
      assert(
        !(await readdir(workspace)).includes("result.txt"),
        "attached workspace must stay in the guest",
      );
    } else assert.equal(await readFile(join(workspace, "result.txt"), "utf8"), "package-ok");
    child.stdin.end();
    for (let count = 0; child.exitCode === null && count < 1200; count++) await delay(25);
    assert.equal(child.exitCode, 0, errors);
    assert(
      !messages.some((message) => message.type === "extension_error"),
      JSON.stringify(messages),
    );
    children.delete(child);
    if (selected.kind === "bubblewrap") {
      await testParallelTools({
        launch: (args) => launch(["-e", "builtin:codemode", ...args]),
        modelsPath: join(home, "agent/models.json"),
        workspace,
      });
    }
    if (family) {
      const alive = await family.execute(family.sourceId, {
        argv: ["/bin/cat", "/workspace/result.txt"],
      });
      assert.equal(
        alive.stdout.toString(),
        "package-ok",
        "Pi EOF must only detach from an orchestrator-owned machine",
      );
      await family.close();
    }
    if (selected.kind !== "bubblewrap") assert.deepEqual(await readdir(stateDirectory), []);
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
  for (const family of families) {
    try {
      await family.close();
    } catch (error) {
      console.error("Family cleanup uncertain", String(error));
    }
  }
  const retained = [];
  for (const state of vmStates) if ((await readdir(state)).length) retained.push(state);
  if (retained.length)
    console.error(`Preserving failed VM fixture state for scoped recovery: ${retained.join(", ")}`);
  else await rm(temp, { recursive: true, force: true });
}
