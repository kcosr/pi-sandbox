#!/usr/bin/env node

import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:https";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { URL } from "node:url";
import { promisify } from "node:util";
import { parse } from "@iarna/toml";
import {
  macosBundleFinderLauncher,
  macosBundleIcon,
  macosBundleLauncher,
  macosBundleTerminalCommand,
  macosInstalledBundleLauncher,
  macosPackageLayout,
} from "../build/macos-layout.mjs";

const capture = promisify(execFile);
const systemEnvironment = { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C" };
const applicationName = "Pi Sandbox.app";

async function expandPackage(packageFile, expanded) {
  await capture("/usr/sbin/pkgutil", ["--expand-full", packageFile, expanded]);
  const packageInfos = (await readdir(expanded, { recursive: true })).filter((name) =>
    name.endsWith("/PackageInfo"),
  );
  assert.equal(packageInfos.length, 1, "PKG must contain one application component");
  const packageInfo = join(expanded, packageInfos[0]);
  const component = dirname(packageInfo);
  assert.match(await readFile(packageInfo, "utf8"), /\binstall-location="\/Applications"/u);
  assert.deepEqual(await readdir(join(component, "Payload")), [applicationName]);
  const { stdout } = await capture("/usr/bin/lsbom", ["-p", "fmug", join(component, "Bom")]);
  const entries = new Map();
  for (const line of stdout.trimEnd().split("\n")) {
    const [name, mode, uid, gid] = line.split("\t");
    if (name !== `./${applicationName}` && !name.startsWith(`./${applicationName}/`)) continue;
    assert.equal(uid, "0", `Package entry is not root-owned: ${name}`);
    assert.equal(gid, "0", `Package entry is not wheel-owned: ${name}`);
    assert.match(mode, /^[0-7]+$/u, `Invalid package mode: ${name}`);
    const permissions = Number.parseInt(mode, 8) & 0o7777;
    assert([0o644, 0o755].includes(permissions), `Unexpected package permissions: ${name}`);
    entries.set(name, permissions);
  }
  for (const path of [
    `./${applicationName}`,
    `./${applicationName}/${macosBundleLauncher}`,
    `./${applicationName}/${macosBundleFinderLauncher}`,
    `./${applicationName}/${macosBundleTerminalCommand}`,
    `./${applicationName}/Contents/Resources/client/pi-sandbox`,
  ]) {
    assert.equal(entries.get(path), 0o755, `Missing executable or bundle directory: ${path}`);
  }
  assert.equal(entries.get(`./${applicationName}/${macosBundleIcon}`), 0o644);
  const application = join(component, "Payload", applicationName);
  await capture("/usr/bin/codesign", ["--verify", "--deep", "--strict", application]);
  const { stdout: entry } = await capture("/usr/bin/plutil", [
    "-extract",
    "CFBundleExecutable",
    "raw",
    join(application, "Contents/Info.plist"),
  ]);
  assert.equal(entry.trim(), basename(macosBundleFinderLauncher));
  const { stdout: icon } = await capture("/usr/bin/plutil", [
    "-extract",
    "CFBundleIconFile",
    "raw",
    join(application, "Contents/Info.plist"),
  ]);
  assert.equal(icon.trim(), basename(macosBundleIcon));
  const image = join(application, macosBundleIcon);
  const { stdout: properties } = await capture("/usr/bin/sips", ["-g", "format", image]);
  assert.match(properties, /format: icns/u);
  return { application, component };
}

async function verifyTerminalCommand(application, temporary) {
  const fixture = join(temporary, "Finder test.app");
  const command = join(fixture, macosBundleTerminalCommand);
  const launcher = join(fixture, macosBundleLauncher);
  const home = join(temporary, "Finder home");
  await mkdir(home);
  await mkdir(dirname(command), { recursive: true });
  await mkdir(dirname(launcher), { recursive: true });
  await copyFile(join(application, macosBundleTerminalCommand), command);
  await writeFile(launcher, '#!/bin/sh\nprintf "%s\\n" "$PWD"\n', { mode: 0o755 });
  const { stdout } = await capture("/bin/sh", [command], {
    cwd: temporary,
    env: { ...systemEnvironment, HOME: home },
  });
  assert.equal(stdout.trim(), home, "Finder's Terminal script must start in the user's home");
}

async function stageCommandLink(component, application, root) {
  const hook = (name) =>
    capture(join(component, "Scripts", name), ["fixture.pkg", "/Applications", root], {
      env: systemEnvironment,
    });
  const command = join(root, macosPackageLayout.launcherPath);
  await mkdir(dirname(command), { recursive: true });
  await writeFile(command, "existing command");
  await assert.rejects(hook("preinstall"), /Move the existing/u);
  await assert.rejects(hook("postinstall"), /Move the existing/u);
  assert.equal(await readFile(command, "utf8"), "existing command");
  await rm(command);
  await symlink("../libexec/pi-sandbox/pi-sandbox", command);
  await assert.rejects(hook("preinstall"), /Move the existing/u);
  assert.equal(await readlink(command), "../libexec/pi-sandbox/pi-sandbox");
  await rm(join(root, "usr"), { recursive: true });

  await hook("preinstall");
  await assert.rejects(lstat(command), { code: "ENOENT" });
  const stagedApp = join(root, "Applications", applicationName);
  await mkdir(dirname(stagedApp), { recursive: true });
  await rename(application, stagedApp);
  await hook("postinstall");
  assert.equal(await readlink(command), macosInstalledBundleLauncher);
  const { ino } = await lstat(command);
  await hook("preinstall");
  await hook("postinstall");
  assert.equal((await lstat(command)).ino, ino);
  return stagedApp;
}

async function createFixture(temporary, fixtureDirectory, manifest) {
  const { configuration } = manifest.layout;
  assert.equal(configuration.source, "service");
  const { endpoint } = configuration;
  assert.equal(endpoint.transport, "https");
  assert.equal(endpoint.tlsTrust, "custom");
  assert.equal(endpoint.basicUsername, "fixture");
  assert.equal(endpoint.sendMachineId, false);
  const url = new URL(endpoint.url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "127.0.0.1", "The smoke test only accepts a loopback service");
  assert(Number(url.port) >= 1024, "Fixture requires an explicit unprivileged port");
  assert(manifest.toolBundle?.commands.includes("cat"), "Fixture must bundle GNU cat");
  const password = (await readFile(join(fixtureDirectory, "password"), "utf8")).replace(
    /\r?\n$/u,
    "",
  );
  const authorization = `Basic ${Buffer.from(`fixture:${password}`).toString("base64")}`;
  const user = userInfo().username;
  const workspace = join(temporary, "workspace");
  const home = join(temporary, "home");
  const state = join(temporary, "state");
  await Promise.all([workspace, home, state].map((directory) => mkdir(directory)));
  const deniedFile = join(workspace, "protected.txt");
  const deniedContents = "SEATBELT_DENIED_SENTINEL";
  await writeFile(deniedFile, deniedContents);
  const policy = parse(
    await readFile(new URL("../../config/default/config.seatbelt.toml", import.meta.url), "utf8"),
  );
  delete policy.models_file;
  policy.filesystem.denied_paths = [deniedFile];
  policy.sessions.retention_days = 0;
  const environment = {
    pi: { FIXTURE_TOKEN: "unused-offline-fixture-key" },
    sandbox: {},
    extensions: {},
  };
  policy.environment.pi = environment.pi;
  const result = {
    policy,
    overrides: { tools: {} },
    environment,
    models: {
      providers: {
        fixture: {
          baseUrl: `${url.origin}/model-not-used`,
          api: "openai-completions",
          apiKey: "$FIXTURE_TOKEN",
          models: [
            {
              id: "offline",
              name: "Offline fixture",
              reasoning: false,
              input: ["text"],
              contextWindow: 32768,
              maxTokens: 8192,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            },
          ],
        },
      },
    },
    policy_revision: "a".repeat(32),
  };
  let bootstrapRequests = 0;
  const errors = [];
  const server = createServer(
    {
      cert: await readFile(join(fixtureDirectory, "certificate.pem")),
      key: await readFile(join(fixtureDirectory, "key.pem")),
    },
    async (request, response) => {
      try {
        assert.equal(request.method, "POST");
        assert.equal(request.url, url.pathname);
        assert(request.headers.authorization === authorization, "Invalid fixture credentials");
        let body = "";
        for await (const chunk of request.setEncoding("utf8")) {
          body += chunk;
          assert(Buffer.byteLength(body) <= 32768);
        }
        const message = JSON.parse(body);
        assert.equal(message.version, 1);
        assert.match(message.request_id, /^[0-9a-f]{32}$/u);
        assert.equal(message.operation, "bootstrap");
        assert.deepEqual(message.identity, { username: user });
        bootstrapRequests += 1;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            version: 1,
            request_id: message.request_id,
            operation: "bootstrap",
            result,
          }),
        );
      } catch (error) {
        errors.push(error);
        response.writeHead(400).end();
      }
    },
  );
  await once(server.listen(Number(url.port), "127.0.0.1"), "listening");
  return {
    server,
    errors,
    get bootstrapRequests() {
      return bootstrapRequests;
    },
    workspace,
    home,
    state,
    deniedFile,
    deniedContents,
  };
}

async function exerciseLauncher(launcher, payload, fixture) {
  const { workspace, home, state, deniedFile, deniedContents } = fixture;
  const child = spawn(
    launcher,
    ["--mode", "rpc", "--no-session", "--provider", "fixture", "--model", "offline"],
    {
      cwd: workspace,
      env: { ...systemEnvironment, HOME: home, PI_CODING_AGENT_DIR: state, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    },
  );
  let closed;
  const close = new Promise((resolveClose) => {
    child.once("close", (code, signal) => {
      closed = { code, signal };
      resolveClose();
    });
  });
  const replies = new Map();
  let stderr = "";
  let failure;
  let sequence = 0;
  child.on("error", (error) => (failure = error));
  child.stdin.on("error", (error) => (failure = error));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
  createInterface({ input: child.stdout }).on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (typeof message.id === "string") replies.set(message.id, message);
    } catch (error) {
      failure = error;
    }
  });
  async function waitFor(read, purpose) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (fixture.errors.length) throw fixture.errors[0];
      const value = read();
      if (value !== undefined) return value;
      if (closed) throw new Error(`Launcher exited during ${purpose}: ${stderr}`);
      await delay(20);
    }
    throw new Error(`Timed out during ${purpose}: ${stderr}`);
  }
  async function request(type, fields) {
    const id = `pkg-smoke-${++sequence}`;
    child.stdin.write(`${JSON.stringify({ id, type, ...fields })}\n`);
    const response = await waitFor(() => replies.get(id), type);
    assert.equal(response.success, true, JSON.stringify(response));
    return response.data;
  }
  const bash = (command) => request("bash", { command });
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  try {
    await request("get_state");
    const tool = await bash("command -v cat");
    assert.equal(tool.exitCode, 0, tool.output);
    assert.equal(tool.output.trim(), join(payload, "tools/bin/cat"));
    const write = await bash("printf bundle-ok > allowed.txt && cat allowed.txt");
    assert.equal(write.exitCode, 0, write.output);
    assert.equal(write.output, "bundle-ok");
    assert.equal(await readFile(join(workspace, "allowed.txt"), "utf8"), "bundle-ok");
    const readDenied = await bash(`cat ${quote(deniedFile)}`);
    assert.notEqual(readDenied.exitCode, 0);
    assert(!readDenied.output.includes(deniedContents));
    assert.equal(await readFile(deniedFile, "utf8"), deniedContents);
    const outsideFile = join(home, "escaped");
    const outside = await bash(`printf escaped > ${quote(outsideFile)}`);
    assert.notEqual(outside.exitCode, 0);
    await assert.rejects(readFile(outsideFile), { code: "ENOENT" });
    child.stdin.end();
    assert.deepEqual(await waitFor(() => closed, "EOF"), { code: 0, signal: null }, stderr);
  } finally {
    if (!closed) child.kill("SIGKILL");
    await close;
  }
}

if (process.platform !== "darwin" || process.argv.length !== 4 || process.getuid() === 0) {
  throw new Error(
    "usage on macOS as a normal user: macos-pkg-smoke.mjs PACKAGE.pkg FIXTURE_DIRECTORY",
  );
}
const [packageFile, fixtureDirectory] = process.argv.slice(2).map((path) => resolve(path));
const temporary = await realpath(await mkdtemp("/private/tmp/pi-macos-pkg-smoke-"));
let fixture;
try {
  const expanded = await expandPackage(packageFile, join(temporary, "expanded"));
  await verifyTerminalCommand(expanded.application, temporary);
  const application = await stageCommandLink(
    expanded.component,
    expanded.application,
    join(temporary, "target-volume"),
  );
  const launcher = join(application, macosBundleLauncher);
  const payload = join(application, "Contents/Resources/client");
  const manifest = JSON.parse(await readFile(join(payload, "release-manifest.json"), "utf8"));
  assert.equal(manifest.architecture, process.arch);
  assert.equal(manifest.layout.launcherPath, macosPackageLayout.launcherPath);
  assert(manifest.executionBackends.includes("seatbelt"));
  const { stdout } = await capture(launcher, ["--version"], { env: systemEnvironment });
  assert.equal(stdout.trim(), manifest.buildVersion.displayVersion);
  const stagedCommand = join(temporary, "pi-sandbox");
  // The real package link targets the installed volume's absolute application path.
  await symlink(launcher, stagedCommand);
  fixture = await createFixture(temporary, fixtureDirectory, manifest);
  await exerciseLauncher(stagedCommand, payload, fixture);
  assert.equal(fixture.bootstrapRequests, 1);
  assert.deepEqual(fixture.errors, []);
  console.log(
    "PASS PKG ownership, strict app signature, command link, HTTPS bootstrap, bundled cat and Seatbelt",
  );
} finally {
  if (fixture) {
    const closed = once(fixture.server, "close");
    fixture.server.close();
    fixture.server.closeAllConnections();
    await closed;
  }
  await rm(temporary, { recursive: true, force: true });
}
