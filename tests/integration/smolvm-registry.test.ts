import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { SmolvmCli } from "../../packages/sandbox-extension/src/runtime/smolvm/cli.js";
import {
  captureMachineIdentity,
  checkedCommand,
  deleteStoppedMachine,
  listMachines,
  stopMachine,
} from "../../packages/sandbox-extension/src/runtime/smolvm/lifecycle.js";
import {
  createSmolvmOciFamily,
  reopenSmolvmOciFamily,
} from "../../packages/sandbox-extension/src/runtime/smolvm/oci/family.js";
import {
  createSmolvmEnvironment,
  uniqueMachineName,
} from "../../packages/sandbox-extension/src/runtime/smolvm/registry.js";
import {
  assertNoFixtureLayerAttachments,
  nativeHostProcessAlive,
  nativeSmolvmHostTools,
} from "../fixtures/smolvm-native-host.js";

const enabled =
  process.env.PI_SANDBOX_REQUIRE_SMOLVM === "1" || !!process.env.PI_SANDBOX_SMOLVM_OCI_IMAGE;
let root: string;
let cli: SmolvmCli;
let environment: Record<string, string>;
beforeAll(async () => {
  if (!enabled) return;
  for (const key of [
    "PI_SANDBOX_SMOLVM_BIN",
    "PI_SANDBOX_SMOLVM_IMAGE",
    "PI_SANDBOX_SMOLVM_IMAGE_SHA256",
    "PI_SANDBOX_SMOLVM_OCI_IMAGE",
    "PI_SANDBOX_SMOLVM_OCI_SHA256",
  ])
    if (!process.env[key]) throw new Error(`Missing required native fixture input: ${key}`);
  root = await realpath(await mkdtemp("/tmp/reg-test-"));
  for (const [key, name] of Object.entries({
    HOME: "h",
    XDG_DATA_HOME: "d",
    XDG_CACHE_HOME: "c",
    XDG_CONFIG_HOME: "x",
    XDG_STATE_HOME: "s",
    XDG_RUNTIME_DIR: "r",
  })) {
    await mkdir(path.join(root, name), { mode: 0o700 });
    vi.stubEnv(key, path.join(root, name));
  }
  vi.stubEnv("SMOLVM_CONFIG", path.join(root, "config.toml"));
  await writeFile(process.env.SMOLVM_CONFIG!, "", { mode: 0o600 });
  environment = createSmolvmEnvironment(nativeSmolvmHostTools().e2fsprogsDirectory);
  assertNoFixtureLayerAttachments(root);
  cli = new SmolvmCli({
    smolvmPath: process.env.PI_SANDBOX_SMOLVM_BIN!,
    stateDirectory: root,
    nativeEnvironment: environment,
  });
});
afterAll(async () => {
  if (!enabled) return;
  try {
    expect(await listMachines(cli)).toEqual([]);
    assertNoFixtureLayerAttachments(root);
    await cli.dispose();
    await rm(root, { recursive: true, force: true });
  } catch (error) {
    console.error("Shared account fixture retained", root);
    throw error;
  } finally {
    vi.unstubAllEnvs();
  }
});
describe.skipIf(!enabled)("native shared registry isolation and manual recovery", () => {
  it("keeps an unrelated stock named VM intact through family branching, retention, reopening and deletion", async () => {
    const foreign = uniqueMachineName("foreign");
    await checkedCommand(cli, [
      "machine",
      "create",
      "--name",
      foreign,
      "--image",
      process.env.PI_SANDBOX_SMOLVM_OCI_IMAGE!,
      "--cpus",
      "1",
      "--mem",
      "512",
      "--storage",
      "2",
      "--overlay",
      "1",
      "--",
      "/bin/sleep",
      "infinity",
    ]);
    await checkedCommand(cli, ["machine", "start", "--name", foreign]);
    const identity = await captureMachineIdentity(cli, foreign);
    assertNoFixtureLayerAttachments(root);
    let family: Awaited<ReturnType<typeof createSmolvmOciFamily>> | undefined;
    try {
      await checkedCommand(cli, [
        "machine",
        "exec",
        "--name",
        foreign,
        "--",
        "/bin/sh",
        "-c",
        "echo untouched >/foreign-marker",
      ]);
      const state = path.join(root, "controller");
      await mkdir(state, { mode: 0o700 });
      family = await createSmolvmOciFamily({
        ...nativeSmolvmHostTools(),
        smolvmPath: process.env.PI_SANDBOX_SMOLVM_BIN!,
        imageArchive: process.env.PI_SANDBOX_SMOLVM_OCI_IMAGE!,
        imageSha256: process.env.PI_SANDBOX_SMOLVM_OCI_SHA256!,
        stateDirectory: state,
        cwd: "/workspace",
        networkMode: "none",
        resources: { cpus: 1, memoryMiB: 512, storageGiB: 2, overlayGiB: 1 },
      });
      const leaf = await family.branch(family.sourceId, { branchable: false });
      await family.removeMachine(leaf);
      const retained = await family.retainForColdReopen();
      family = await reopenSmolvmOciFamily({ statePath: retained.statePath });
      await family.close();
      expect((await listMachines(cli)).map((m) => m.name)).toEqual([foreign]);
      expect(await captureMachineIdentity(cli, foreign)).toEqual(identity);
      expect(
        (
          await checkedCommand(cli, [
            "machine",
            "exec",
            "--name",
            foreign,
            "--",
            "/bin/cat",
            "/foreign-marker",
          ])
        ).stdout.toString(),
      ).toBe("untouched\n");
    } finally {
      await family?.close();
      await stopMachine(cli, foreign, identity);
      await deleteStoppedMachine(cli, foreign, identity);
    }
  }, 180000);
  it.each(["pid", "group"])(
    "recovers the recorded owned VM through stock CLI after owner %s SIGKILL",
    async (mode) => {
      const state = path.join(root, `owner-${mode}`),
        cwd = path.join(root, `project-${mode}`);
      await mkdir(state, { mode: 0o700 });
      await mkdir(cwd);
      const options = {
        ...nativeSmolvmHostTools(),
        cwd,
        stateDirectory: state,
        smolvmPath: process.env.PI_SANDBOX_SMOLVM_BIN!,
        imagePath: process.env.PI_SANDBOX_SMOLVM_IMAGE!,
        imageSha256: process.env.PI_SANDBOX_SMOLVM_IMAGE_SHA256!,
        resources: { cpus: 1, memoryMiB: 512, storageGiB: 1, overlayGiB: 1 },
      };
      const runtime = pathToFileURL(
        path.resolve("packages/sandbox-extension/dist/runtime.js"),
      ).href;
      const source = `import {createSmolvmExecutor} from ${JSON.stringify(runtime)};const vm=await createSmolvmExecutor(JSON.parse(process.argv[1]));await vm.execute({argv:['/bin/bash','-c','(while :; do printf x >>heartbeat; sleep .05; done) >/dev/null 2>&1 &']});process.stdout.write('READY\\n');setInterval(()=>{},1000);`;
      const owner = spawn(
        process.execPath,
        ["--input-type=module", "-e", source, JSON.stringify(options)],
        { cwd, env: environment, detached: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "",
        errors = "";
      owner.stdout.on("data", (b) => {
        output += b;
      });
      owner.stderr.on("data", (b) => {
        errors += b;
      });
      const completion = once(owner, "exit");
      let name: string | undefined;
      try {
        const end = Date.now() + 90000;
        while (!output.includes("READY\n")) {
          if (owner.exitCode !== null || owner.signalCode !== null || Date.now() > end)
            throw new Error(`owner failed: ${errors}`);
          await delay(25);
        }
        const entries = await readdir(state);
        expect(entries).toHaveLength(1);
        const record = JSON.parse(
          await readFile(path.join(state, entries[0]!, "owner.json"), "utf8"),
        ) as { machine: string };
        name = record.machine;
        const identity = await captureMachineIdentity(cli, name);
        const pids = (await listMachines(cli)).filter((m) => m.name === name).map((m) => m.pid!);
        process.kill(mode === "group" ? -owner.pid! : owner.pid!, "SIGKILL");
        await completion;
        await delay(150);
        // A surviving VM is accepted. Recovery uses only the recorded exact name.
        console.info(
          "owner death fixture",
          JSON.stringify({ mode, vmObservedAlive: await nativeHostProcessAlive(pids[0]!) }),
        );
        expect(await readdir(state)).toEqual(entries);
        await stopMachine(cli, name, identity);
        await deleteStoppedMachine(cli, name, identity);
        expect((await listMachines(cli)).some((m) => m.name === name)).toBe(false);
        const heartbeat = await readFile(path.join(cwd, "heartbeat"));
        await delay(150);
        expect(await readFile(path.join(cwd, "heartbeat"))).toEqual(heartbeat);
        expect(await nativeHostProcessAlive(pids[0]!)).toBe(false);
        name = undefined;
      } finally {
        if (owner.exitCode === null && owner.signalCode === null) {
          owner.kill("SIGKILL");
          await completion;
        }
        if (name) console.error("Manual recovery fixture retained", state, name);
      }
    },
    120000,
  );
});
