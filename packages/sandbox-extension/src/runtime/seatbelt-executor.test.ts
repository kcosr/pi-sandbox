import { selectedTestToolBundle } from "../../../../tests/support/tool-bundle.js";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import {
  access,
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { constants } from "node:fs";
import { createServer } from "node:net";
import { createSocket } from "node:dgram";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  createSeatbeltExecutor,
  seatbeltCommandEnvironment,
  type CreateSeatbeltExecutorOptions,
} from "./seatbelt-executor.js";
import { resolveDirectToolCommands } from "./direct-executor.js";
import type { SandboxExecutor } from "./contracts.js";

const node = await realpath(process.execPath);
const bun = process.env.PI_SANDBOX_TEST_BUN;
const toolBundle = selectedTestToolBundle();
const prerequisite = await (async () => {
  if (process.platform !== "darwin") return "requires native macOS";
  try {
    await access("/usr/bin/sandbox-exec", constants.X_OK);
    await resolveDirectToolCommands("darwin", toolBundle);
    if (bun !== undefined) {
      if (!path.isAbsolute(bun)) return "PI_SANDBOX_TEST_BUN must be an absolute verified Bun path";
      await access(bun, constants.X_OK);
    }
    return undefined;
  } catch (cause) {
    return String(cause);
  }
})();
const runtimes: [string, string][] = [["Node", node]];
if (bun !== undefined) runtimes.push(["Bun", bun]);
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const executeHost = promisify(execFile);
async function waitForFile(file: string): Promise<string> {
  for (let i = 0; i < 150; i++) {
    try {
      return await readFile(file, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
    await delay(20);
  }
  throw new Error(`fixture did not write ${file}`);
}

it("describes the fixed and administrator Seatbelt command environment", () => {
  const environment = seatbeltCommandEnvironment(
    { ADMIN_VALUE: "configured" },
    { root: "/opt/pi-sandbox/tools", commands: {} },
  );
  expect(environment).toEqual({
    ADMIN_VALUE: "configured",
    PATH: "/opt/pi-sandbox/tools/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
    LANG: "C.UTF-8",
  });
  expect(Object.isFrozen(environment)).toBe(true);
  expect(seatbeltCommandEnvironment().PATH).toBe(
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
  );
  for (const name of ["PATH", "HOME", "BASH_ENV", "PI_SANDBOX_VALUE"])
    expect(() => seatbeltCommandEnvironment({ [name]: "/x" })).toThrow(
      "sandbox_environment_invalid",
    );
});

it("requires genuine native Seatbelt and GNU prerequisites when requested", () => {
  if (process.env.PI_SANDBOX_REQUIRE_SEATBELT === "1") {
    expect(prerequisite).toBeUndefined();
    expect(bun, "supply the verified Bun used by the release").toBeTruthy();
  }
});

describe.skipIf(prerequisite !== undefined)("native Seatbelt executor", () => {
  let root: string;
  let fixture: string;
  let cwd: string;
  let secret: string;
  let hostBundle: string;
  let executors: SandboxExecutor[];
  beforeAll(async () => {
    root = await realpath(await mkdtemp("/private/tmp/pi-seatbelt-tests-"));
    hostBundle = path.join(root, "runtime.mjs");
    await build({
      entryPoints: [path.resolve("packages/sandbox-extension/src/runtime/seatbelt-executor.ts")],
      outfile: hostBundle,
      platform: "node",
      target: "node24",
      format: "esm",
      bundle: true,
    });
  });
  beforeEach(async () => {
    fixture = await mkdtemp(path.join(root, "case-"));
    cwd = path.join(fixture, "workspace");
    secret = path.join(fixture, "secret");
    await mkdir(cwd);
    await mkdir(secret);
    await writeFile(path.join(secret, "marker"), "protected");
    await writeFile(path.join(cwd, "marker"), "workspace");
    executors = [];
  });
  afterEach(async () => {
    await Promise.all(executors.map((executor) => executor.close()));
    await rm(fixture, { recursive: true, force: true });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });
  async function create(options: Partial<CreateSeatbeltExecutorOptions> = {}) {
    const executor = await createSeatbeltExecutor({
      cwd,
      deniedPaths: [secret],
      ...(toolBundle === undefined ? {} : { toolBundle }),
      ...options,
    });
    executors.push(executor);
    return executor;
  }

  it.each(runtimes)(
    "%s uses clean environment, real private scratch and binary streams",
    async (_name, runtime) => {
      process.env.SEATBELT_SYNTHETIC_SECRET = "must-not-inherit";
      try {
        const executor = await create({ environment: { ADMIN_VALUE: "configured" } });
        const result = await executor.execute({
          argv: [
            runtime,
            "-e",
            `
        const fs=require('node:fs');if(process.env.SEATBELT_SYNTHETIC_SECRET)throw Error('inherited');
        if(process.env.ADMIN_VALUE!=='configured')throw Error('configuration');
        fs.writeFileSync(process.env.TMPDIR+'/persist','private');
        console.log(JSON.stringify({cwd:process.cwd(),home:process.env.HOME,temp:process.env.TMPDIR,path:process.env.PATH}));`,
          ],
        });
        expect(result.exitCode).toBe(0);
        const env = JSON.parse(result.stdout.toString()) as {
          cwd: string;
          home: string;
          temp: string;
          path: string;
        };
        expect(env.cwd).toBe(cwd);
        expect(env.home).toBe(executor.home);
        expect(env.temp).toMatch(/^\/private\/tmp\/pi-sandbox-[^/]+\/tmp$/u);
        expect(env.path).toBe(
          `${toolBundle === undefined ? "" : `${toolBundle.root}/bin:`}/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
        );
        expect(env.path).toBe(seatbeltCommandEnvironment({}, toolBundle).PATH);
        const input = Buffer.from([0, 255, 12, 127, 0]);
        const chunks: Buffer[] = [];
        const binary = await executor.execute(
          { argv: [executor.commands.cat], stdin: input },
          { onStdout: (chunk) => chunks.push(chunk) },
        );
        expect(binary.stdout).toEqual(input);
        expect(Buffer.concat(chunks)).toEqual(input);
        expect(
          (
            await executor.execute({
              argv: [executor.commands.cat, path.join(env.temp, "persist")],
            })
          ).stdout.toString(),
        ).toBe("private");
        await executor.close();
        await expect(access(executor.home)).rejects.toThrow();
      } finally {
        delete process.env.SEATBELT_SYNTHETIC_SECRET;
      }
    },
  );

  it("composes denied ancestors and descendants and rejects symlink writes outside CWD", async () => {
    const protectedPath = path.join(cwd, "parent", "private");
    await mkdir(protectedPath, { recursive: true });
    await writeFile(path.join(protectedPath, "marker"), "nested");
    await symlink(path.join(secret, "marker"), path.join(cwd, "alias"));
    const executor = await create({ deniedPaths: [fixture, protectedPath] });
    const result = await executor.execute({
      argv: [
        node,
        "-e",
        `
      const fs=require('node:fs');const denied=(f)=>{try{f();throw Error('allowed')}catch(e){if(e.code!=='EPERM')throw e}};
      if(fs.readFileSync('marker','utf8')!=='workspace')throw Error('workspace');fs.writeFileSync('allowed','yes');
      denied(()=>fs.readFileSync(${JSON.stringify(path.join(secret, "marker"))}));
      denied(()=>fs.readFileSync('parent/private/marker'));denied(()=>fs.writeFileSync('alias','bad'));
      denied(()=>fs.renameSync('parent','moved'));console.log('confined');`,
      ],
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe("confined");
    expect(await readFile(path.join(secret, "marker"), "utf8")).toBe("protected");
  });

  it("retains the explicit pre-existing hardlink limitation", async () => {
    await link(path.join(secret, "marker"), path.join(cwd, "hardlink"));
    const executor = await create();
    const result = await executor.execute({
      argv: [node, "-e", "require('node:fs').writeFileSync('hardlink','changed-through-link')"],
    });
    expect(result.exitCode).toBe(0);
    expect(await readFile(path.join(secret, "marker"), "utf8")).toBe("changed-through-link");
  });

  it("denies read-only workspace writes while preserving private scratch writes", async () => {
    const executor = await create({ cwdWritable: false });
    const result = await executor.execute({
      argv: [
        node,
        "-e",
        `
      const fs=require('node:fs');try{fs.writeFileSync('blocked','bad');throw Error('allowed')}catch(e){if(e.code!=='EPERM')throw e}
      fs.writeFileSync(process.env.TMPDIR+'/allowed','yes');console.log(fs.readFileSync('marker','utf8'));`,
      ],
    });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
    expect(result.stdout.toString().trim()).toBe("workspace");
  });

  it("rejects missing, file and aliased policy paths without fallback", async () => {
    const alias = path.join(fixture, "alias");
    await symlink(cwd, alias);
    for (const options of [
      { cwd: alias },
      { deniedPaths: [alias] },
      { deniedPaths: [path.join(secret, "marker")] },
      { deniedPaths: [path.join(fixture, "absent")] },
    ])
      await expect(create(options)).rejects.toMatchObject({ code: "sandbox_start_failed" });
  });

  it("blocks actual TCP, UDP and Unix traffic under none with working host-mode controls", async () => {
    const tcp = createServer((socket) => {
      socket.on("error", () => {});
      socket.end("positive");
    });
    const unix = createServer((socket) => {
      socket.on("error", () => {});
      socket.end("positive");
    });
    const udp = createSocket("udp4");
    const unixPath = path.join(cwd, "fixture.sock");
    await new Promise<void>((resolve) => tcp.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => unix.listen(unixPath, resolve));
    await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
    const tcpAddress = tcp.address();
    const udpPort = udp.address().port;
    if (tcpAddress === null || typeof tcpAddress === "string") throw new Error("fixture address");
    const source = `const net=require('node:net'),dgram=require('node:dgram');
      const connect=(where)=>new Promise(r=>{const s=net.connect(where);s.on('connect',()=>{s.destroy();r(true)});s.on('error',()=>r(false))});
      const send=()=>new Promise(r=>{const s=dgram.createSocket('udp4');let done=false;const finish=(ok)=>{if(done)return;done=true;try{s.close()}catch{}r(ok)};s.on('error',()=>finish(false));s.send('probe',${udpPort},'127.0.0.1',e=>finish(!e))});
      Promise.all([connect({host:'127.0.0.1',port:${tcpAddress.port}}),connect({path:${JSON.stringify(unixPath)}}),send()]).then(r=>console.log(JSON.stringify(r)));`;
    try {
      for (const mode of ["host", "none"] as const) {
        const executor = await create({ networkMode: mode });
        const result = await executor.execute({ argv: [node, "-e", source], timeoutMs: 3000 });
        expect(result.exitCode, result.stderr.toString()).toBe(0);
        expect(JSON.parse(result.stdout.toString())).toEqual(Array(3).fill(mode === "host"));
      }
    } finally {
      udp.close();
      await Promise.all([
        new Promise<void>((resolve) => tcp.close(() => resolve())),
        new Promise<void>((resolve) => unix.close(() => resolve())),
      ]);
    }
  });

  it("resolves localhost through the host resolver in both network modes", async () => {
    const source =
      "require('node:dns').lookup('localhost',{all:true},(e,a)=>{if(e)throw e;console.log(JSON.stringify(a.map(x=>x.address)))})";
    const host = await executeHost(node, ["-e", source], { timeout: 3000 });
    expect(JSON.parse(host.stdout)).toContain("127.0.0.1");
    for (const networkMode of ["none", "host"] as const) {
      const executor = await create({ networkMode });
      const result = await executor.execute({ argv: [node, "-e", source], timeoutMs: 3000 });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toContain("127.0.0.1");
    }
  });

  // Explicit opt-in keeps the ordinary suite offline. This resolves a public
  // documentation domain only; it never connects to a provider or web server.
  it.skipIf(process.env.PI_SANDBOX_TEST_PUBLIC_DNS !== "1")(
    "resolves a public hostname in host mode when the host resolver succeeds",
    async () => {
      const source =
        "require('node:dns').lookup('example.com',{all:true},(e,a)=>{if(e)throw e;console.log(JSON.stringify(a.map(x=>x.address)))})";
      const host = await executeHost(node, ["-e", source], { timeout: 3000 });
      expect(JSON.parse(host.stdout)).toEqual(expect.arrayContaining([expect.any(String)]));
      const executor = await create({ networkMode: "host" });
      const result = await executor.execute({ argv: [node, "-e", source], timeoutMs: 3000 });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
      expect(JSON.parse(result.stdout.toString())).toEqual(
        expect.arrayContaining([expect.any(String)]),
      );
    },
  );

  it.each(["cancel", "timeout", "close", "overflow"] as const)(
    "attempts active process-group cleanup on %s",
    async (mode) => {
      const executor = await create();
      const abort = new AbortController();
      const descendant = `setTimeout(()=>require('node:fs').writeFileSync('late','unexpected'),600)`;
      const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});console.log('ready');setInterval(()=>{},1000);`;
      const result = executor.execute(
        {
          argv: [node, "-e", script],
          timeoutMs: mode === "timeout" ? 200 : 3000,
          maxOutputBytes: mode === "overflow" ? 2 : 1024,
        },
        {
          signal: abort.signal,
          onStdout: () => {
            if (mode === "cancel") abort.abort();
          },
        },
      );
      const rejected = expect(result).rejects.toMatchObject({
        code:
          mode === "cancel"
            ? "sandbox_aborted"
            : mode === "close"
              ? "sandbox_closed"
              : mode === "overflow"
                ? "sandbox_output_limit_exceeded"
                : "sandbox_timeout",
      });
      if (mode === "close") {
        await delay(100);
        await executor.close();
      }
      await rejected;
      await delay(650);
      await expect(access(path.join(cwd, "late"))).rejects.toThrow();
    },
  );

  it.each(runtimes)(
    "%s ordinary and detached descendants retain original grants after completion and close",
    async (_name, runtime) => {
      for (const detached of [false, true]) {
        const executor = await create();
        const marker = path.join(cwd, `survivor-${detached}`);
        const survivor = `setTimeout(()=>{const fs=require('node:fs');let denied=false;try{fs.readFileSync(${JSON.stringify(path.join(secret, "marker"))})}catch(e){denied=e.code==='EPERM'}fs.writeFileSync(${JSON.stringify(marker)},denied?'original-confined-grants':'FAILED')},800)`;
        const script = `const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(survivor)}],{detached:${detached},stdio:'ignore'});p.unref();`;
        expect((await executor.execute({ argv: [runtime, "-e", script] })).exitCode).toBe(0);
        await executor.close();
        const readonly = await create({ cwdWritable: false });
        expect(await waitForFile(marker)).toBe("original-confined-grants");
        await readonly.close();
      }
    },
  );

  it.each(runtimes)(
    "%s can own the executor and abrupt owner death leaves confined original-grant descendants",
    async (_name, runtime) => {
      const marker = path.join(cwd, "after-owner-death");
      const survivor = `setTimeout(()=>{const fs=require('node:fs');let denied=false;try{fs.readFileSync(${JSON.stringify(path.join(secret, "marker"))})}catch(e){denied=e.code==='EPERM'}fs.writeFileSync(${JSON.stringify(marker)},denied?'confined-after-owner-death':'FAILED')},900)`;
      const launch = `const p=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(survivor)}],{detached:true,stdio:'ignore'});p.unref();`;
      const script = `import {createSeatbeltExecutor} from ${JSON.stringify(hostBundle)};
      const e=await createSeatbeltExecutor({cwd:${JSON.stringify(cwd)},deniedPaths:[${JSON.stringify(secret)}],toolBundle:${JSON.stringify(toolBundle)}});
      const r=await e.execute({argv:[${JSON.stringify(runtime)},'-e',${JSON.stringify(launch)}]});
      if(r.exitCode!==0)throw Error(r.stderr.toString());console.log(JSON.stringify({home:e.home}));setInterval(()=>{},1000);`;
      const child = spawn(runtime, ["--input-type=module", "-e", script], {
        env: { PATH: "/usr/bin:/bin" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let output = "",
        diagnostics = "";
      child.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        diagnostics += chunk.toString();
      });
      const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
      let scratch: string | undefined;
      try {
        for (let i = 0; !output.includes("\n") && i < 150; i++) {
          if (child.exitCode !== null) throw new Error(diagnostics);
          await delay(20);
        }
        const record = JSON.parse(output.trim()) as { home: string };
        scratch = path.dirname(record.home);
        expect(scratch).toMatch(/^\/private\/tmp\/pi-sandbox-[^/]+$/u);
        child.kill("SIGKILL");
        await closed;
        expect(await waitForFile(marker)).toBe("confined-after-owner-death");
      } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await closed;
        // The finite descendant writes only its fixture CWD and exits after the marker.
        await delay(100);
        if (scratch) await rm(scratch, { recursive: true, force: true });
      }
    },
  );

  it("confines scratch cleanup even with an outside symlink", async () => {
    const executor = await create();
    await symlink(secret, path.join(executor.home, "outside"));
    await executor.close();
    expect(await readFile(path.join(secret, "marker"), "utf8")).toBe("protected");
  });

  it("denies host process argument/environment inspection and signalling with positive controls", async () => {
    const host = spawn(node, ["-e", "setInterval(()=>{},1000)", "seatbelt-argv-marker"], {
      env: { PATH: "/usr/bin:/bin", SEATBELT_PROCESS_SECRET: "synthetic-process-secret" },
      stdio: "ignore",
    });
    const closed = new Promise<void>((resolve) => host.once("close", () => resolve()));
    try {
      await once(host, "spawn");
      const args = ["eww", "-p", String(host.pid), "-o", "command="];
      const positive = await executeHost("/bin/ps", args, { env: { PATH: "/usr/bin:/bin" } });
      expect(positive.stdout).toContain("seatbelt-argv-marker");
      expect(positive.stdout).toContain("synthetic-process-secret");
      expect(() => process.kill(host.pid!, 0)).not.toThrow();
      for (const networkMode of ["none", "host"] as const) {
        const executor = await create({ networkMode });
        const inspection = await executor.execute({ argv: ["/bin/ps", ...args] });
        expect(inspection.stdout.toString()).not.toContain("seatbelt-argv-marker");
        expect(inspection.stdout.toString()).not.toContain("synthetic-process-secret");
        const signal = await executor.execute({
          argv: [
            node,
            "-e",
            `try{process.kill(${host.pid},0);throw Error('allowed')}catch(e){if(e.code!=='EPERM')throw e;console.log('denied')}`,
          ],
        });
        expect(signal.exitCode, signal.stderr.toString()).toBe(0);
        expect(signal.stdout.toString().trim()).toBe("denied");
      }
    } finally {
      if (host.exitCode === null && host.signalCode === null) host.kill("SIGKILL");
      await closed;
    }
  });

  it.each(runtimes)(
    "%s closes an intentionally inherited host descriptor before sandbox execution",
    async (_name, runtime) => {
      const descriptor = await open(path.join(secret, "marker"), "r");
      const source = `import fs from 'node:fs';import {createSeatbeltExecutor} from ${JSON.stringify(hostBundle)};
      if(fs.readFileSync(57,'utf8')!=='protected')throw Error('positive descriptor control');
      const e=await createSeatbeltExecutor({cwd:${JSON.stringify(cwd)},deniedPaths:[${JSON.stringify(secret)}],toolBundle:${JSON.stringify(toolBundle)}});
      try{const r=await e.execute({argv:[${JSON.stringify(runtime)},'-e',"try{require('node:fs').fstatSync(57);throw Error('inherited')}catch(e){if(e.code!=='EBADF')throw e;console.log('closed')}"]});
      if(r.exitCode!==0||r.stdout.toString().trim()!=='closed')throw Error('descriptor leaked '+r.stderr);console.log('descriptor-ok')}finally{await e.close()}`;
      const stdio: ("ignore" | "pipe" | number)[] = Array.from(
        { length: 58 },
        () => "ignore" as const,
      );
      stdio[1] = "pipe";
      stdio[2] = "pipe";
      stdio[57] = descriptor.fd;
      const host = spawn(runtime, ["--input-type=module", "-e", source], {
        env: { PATH: "/usr/bin:/bin" },
        stdio,
      });
      let stdout = "",
        stderr = "";
      host.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      host.stderr!.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const timer = setTimeout(() => host.kill("SIGKILL"), 4000);
      try {
        const code = await new Promise<number | null>((resolve, reject) => {
          host.once("close", resolve);
          host.once("error", reject);
        });
        expect(code, stderr).toBe(0);
        expect(stdout.trim()).toBe("descriptor-ok");
      } finally {
        clearTimeout(timer);
        await descriptor.close();
      }
    },
  );
});
