import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { parse as parseToml, stringify as stringifyToml } from "@iarna/toml";

/** Offline discovery and precedence checks through the compiled managed application. */
export async function testSharedSkills({
  launch,
  configPath,
  userState,
  sharedDirectory,
  visibleSharedDirectory,
}) {
  const originalConfig = await readFile(configPath, "utf8");
  const settingsPath = join(userState, "settings.json");
  const originalSettings = await readFile(settingsPath, "utf8").catch((error) => {
    if (error.code !== "ENOENT") throw error;
    return undefined;
  });
  const config = parseToml(originalConfig);
  config.skills = { directories: [visibleSharedDirectory] };
  const name = "shared-smoke-team";
  const bundled = join(sharedDirectory, "nested", name);
  const visibleBundled = join(visibleSharedDirectory, "nested", name);
  const personal = join(userState, "skills", name);
  const explicit = join(dirname(userState), "explicit", name);
  const secondUser = join(dirname(userState), "second-user");
  const writeSkill = async (path, description) => {
    await mkdir(path, { recursive: true });
    await writeFile(
      join(path, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n---\nRead support.txt and run script.sh as needed.\n`,
    );
  };
  await writeSkill(bundled, "Shared smoke version");
  await writeFile(join(bundled, "support.txt"), "SHARED_SKILL_READ_OK");
  await writeFile(join(bundled, "script.sh"), "#!/bin/sh\nprintf SHARED_SKILL_SCRIPT_OK\n");
  await chmod(join(bundled, "script.sh"), 0o755);
  await mkdir(secondUser);
  const commands = async (args = [], exercise = false) =>
    withRpc(launch(args), async (request) => {
      const find = async () =>
        (await request("get_commands")).commands.filter(
          (command) => command.name === `skill:${name}`,
        );
      const result = await find();
      if (exercise) {
        await request("new_session");
        assert.deepEqual(await find(), result, "runtime recreation must retain shared roots");
        const script = await request("bash", {
          command: shellQuote(join(visibleBundled, "script.sh")),
        });
        assert.equal(script.exitCode, 0, JSON.stringify(script));
        assert.equal(script.output, "SHARED_SKILL_SCRIPT_OK");
        const write = await request("bash", {
          command: `printf overwrite > ${shellQuote(join(visibleBundled, "support.txt"))}`,
        });
        assert.notEqual(
          write.exitCode,
          0,
          "shared assets outside CWD retain ordinary read-only confinement",
        );
        assert.equal(await readFile(join(bundled, "support.txt"), "utf8"), "SHARED_SKILL_READ_OK");
      }
      return result;
    });
  const expectVersion = async (description, args = [], exercise = false) => {
    const result = await commands(args, exercise);
    assert.equal(result.length, 1, JSON.stringify(result));
    assert.equal(result[0].description, description);
  };
  try {
    await writeFile(configPath, stringifyToml(config));
    await writeFile(settingsPath, "{}");
    await expectVersion("Shared smoke version", [], config.execution.backend !== "direct");
    config.environment.pi.PI_CODING_AGENT_DIR = secondUser;
    await writeFile(configPath, stringifyToml(config));
    await expectVersion("Shared smoke version");
    config.environment.pi.PI_CODING_AGENT_DIR = userState;
    await writeFile(configPath, stringifyToml(config));
    for (const skills of [
      [`!${visibleSharedDirectory}/**`],
      [`-${join(visibleBundled, "SKILL.md")}`],
    ]) {
      await writeFile(settingsPath, JSON.stringify({ skills }));
      assert.deepEqual(await commands(), [], "Pi settings must filter shared discovery");
    }
    await writeFile(
      settingsPath,
      JSON.stringify({
        skills: [`!${visibleSharedDirectory}/**`, `+${join(visibleBundled, "SKILL.md")}`],
      }),
    );
    await expectVersion("Shared smoke version");
    await writeFile(settingsPath, "{}");
    assert.deepEqual(await commands(["--no-skills"]), []);
    await writeSkill(personal, "Personal smoke version");
    await expectVersion("Personal smoke version");
    await rm(personal, { recursive: true });
    await writeSkill(explicit, "Explicit smoke version");
    await expectVersion("Explicit smoke version", ["--skill", explicit]);
    await expectVersion("Explicit smoke version", ["--no-skills", "--skill", explicit]);
    await writeFile(
      settingsPath,
      JSON.stringify({ skills: [visibleSharedDirectory, `!${visibleSharedDirectory}/**`] }),
    );
    assert.deepEqual(
      await commands(),
      [],
      "a disabled same-path user entry must not be rediscovered as a default",
    );
  } finally {
    await writeFile(configPath, originalConfig);
    if (originalSettings === undefined) await rm(settingsPath, { force: true });
    else await writeFile(settingsPath, originalSettings);
    await rm(personal, { recursive: true, force: true });
  }
  return {
    directory: visibleSharedDirectory,
    support: join(visibleBundled, "support.txt"),
    script: join(visibleBundled, "script.sh"),
    name,
  };
}

async function withRpc(child, operation) {
  const messages = [];
  let stderr = "";
  let failure;
  let sequence = 0;
  const ended = new Promise((resolve) => {
    child.once("error", (error) => {
      failure = error;
      resolve({ code: null });
    });
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin.on("error", (error) => {
    failure = error;
  });
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      messages.push(JSON.parse(line));
    } catch {
      failure = new Error(`Invalid skills RPC output: ${line}`);
    }
  });
  try {
    const result = await operation(async (type, fields = {}) => {
      const id = `skills-${++sequence}`;
      child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
      const deadline = Date.now() + 15000;
      while (Date.now() < deadline) {
        if (failure) throw failure;
        if (child.exitCode !== null || child.signalCode !== null)
          throw new Error(`Skills RPC exited early: ${stderr}`);
        const message = messages.find(
          (message) => message.id === id && message.type === "response",
        );
        if (message) {
          assert.equal(message.success, true, JSON.stringify(message));
          return message.data;
        }
        await delay(20);
      }
      throw new Error(`Timed out waiting for skills ${type}: ${stderr}`);
    });
    child.stdin.end();
    const exit = await Promise.race([ended, delay(5000, { code: "timeout" }, { ref: false })]);
    assert.equal(exit.code, 0, `Skills RPC shutdown: ${stderr}`);
    assert(!messages.some((message) => message.type === "extension_error"));
    return result;
  } finally {
    lines.close();
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await ended;
    }
  }
}
function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
