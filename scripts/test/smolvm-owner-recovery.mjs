import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createSmolvmExecutor } from "../../packages/sandbox-extension/dist/runtime/smolvm/packed.js";
import { packagedDarwinProcessQuery } from "../../packages/sandbox-extension/dist/runtime/smolvm/darwin-query.js";
import { SmolvmCli } from "../../packages/sandbox-extension/dist/runtime/smolvm/cli.js";
import {
  assertMachineAlive,
  captureMachineIdentity,
  deleteStoppedMachine,
  listMachines,
  stopMachine,
} from "../../packages/sandbox-extension/dist/runtime/smolvm/lifecycle.js";
import { assertNoSmolvmLayerAttachments } from "../../packages/sandbox-extension/dist/runtime/smolvm/platform.js";
import { removeStoppedPrivateState } from "../../packages/sandbox-extension/dist/runtime/smolvm/private-state.js";

if (process.argv[2] === "--child") {
  const options = JSON.parse(await readFile(process.argv[3], "utf8"));
  const vm = await createSmolvmExecutor(options);
  const result = await vm.execute({
    argv: [
      "/bin/bash",
      "-c",
      "(while :; do printf x >>heartbeat; sleep .03; done) >/dev/null 2>&1 &",
    ],
  });
  assert.equal(result.exitCode, 0);
  console.log("READY");
  globalThis.setInterval(() => {}, 1000);
} else {
  const checks = [];
  for (const group of [false, true]) {
    const root = await realpath(await mkdtemp("/tmp/or-"));
    const cwd = path.join(root, "project");
    const stateDirectory = path.join(root, "state");
    await mkdir(cwd);
    await mkdir(stateDirectory, { mode: 0o700 });
    const options = {
      cwd,
      stateDirectory,
      smolvmPath: process.env.PI_SANDBOX_SMOLVM_BIN,
      imagePath: process.env.PI_SANDBOX_SMOLVM_IMAGE,
      imageSha256: process.env.PI_SANDBOX_SMOLVM_IMAGE_SHA256,
      resources: { cpus: 1, memoryMiB: 512, storageGiB: 1, overlayGiB: 1 },
      ...(process.env.PI_SANDBOX_E2FSPROGS_DIRECTORY
        ? { e2fsprogsDirectory: process.env.PI_SANDBOX_E2FSPROGS_DIRECTORY }
        : {}),
      ...(process.platform === "darwin"
        ? { darwinProcessQuery: await packagedDarwinProcessQuery() }
        : {}),
    };
    const config = path.join(root, "fixture.json");
    await writeFile(config, JSON.stringify(options), { mode: 0o600 });
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--child", config], {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" },
    });
    const exited = once(child, "exit");
    let output = "",
      errors = "",
      cli,
      state,
      safe = false;
    child.stdout.on("data", (bytes) => {
      output += bytes;
    });
    child.stderr.on("data", (bytes) => {
      errors += bytes;
    });
    try {
      const deadline = Date.now() + 60000;
      while (!output.includes("READY\n")) {
        if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline)
          throw Error(`owner fixture startup failed: ${errors}`);
        await delay(20);
      }
      const entries = await readdir(stateDirectory);
      assert.equal(entries.length, 1);
      state = path.join(stateDirectory, entries[0]);
      cli = new SmolvmCli({ ...options, stateDirectory: state });
      const identity = await captureMachineIdentity(cli, "workspace");
      process.kill(group ? -child.pid : child.pid, "SIGKILL");
      await exited;
      await assertMachineAlive(identity);
      const first = (await readFile(path.join(cwd, "heartbeat"))).length;
      await delay(200);
      assert((await readFile(path.join(cwd, "heartbeat"))).length > first);
      await stopMachine(cli, "workspace", identity);
      await assert.rejects(assertMachineAlive(identity));
      await assertNoSmolvmLayerAttachments(state);
      const stopped = await readFile(path.join(cwd, "heartbeat"));
      await delay(150);
      assert.deepEqual(await readFile(path.join(cwd, "heartbeat")), stopped);
      await deleteStoppedMachine(cli, "workspace");
      assert.deepEqual(await listMachines(cli), []);
      await assertNoSmolvmLayerAttachments(state);
      await cli.dispose();
      await removeStoppedPrivateState(state);
      safe = true;
      checks.push({
        ownerDeath: group ? "process-group SIGKILL" : "PID SIGKILL",
        vmmSurvivedOwner: true,
        generation: identity.start,
        manualStockRecovery: "confirmed",
        writerStopped: true,
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await exited;
      }
      await cli?.dispose();
      if (safe) await rm(root, { recursive: true, force: true });
      else
        console.error(
          "Owner fixture retained for manual recovery:",
          root,
          state ?? "startup state",
        );
    }
  }
  console.log(
    JSON.stringify({
      runtime: process.versions.bun
        ? `Bun ${process.versions.bun}`
        : `Node ${process.versions.node}`,
      checks,
    }),
  );
}
