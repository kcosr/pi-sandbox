import { constants } from "node:fs";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { build } from "esbuild";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { selectedTestToolBundle } from "../../../../tests/support/tool-bundle.js";
import { resolveDirectToolCommands } from "./direct-executor.js";

const executeHost = promisify(execFile);
const node = await realpath(process.execPath);
const bun = process.env.PI_SANDBOX_TEST_BUN;
const toolBundle = selectedTestToolBundle();
const prerequisite = await (async () => {
  if (process.platform !== "darwin") return "requires native macOS";
  try {
    await access("/usr/bin/sandbox-exec", constants.X_OK);
    await resolveDirectToolCommands("darwin", toolBundle);
    if (bun !== undefined) {
      if (!path.isAbsolute(bun)) return "PI_SANDBOX_TEST_BUN must be absolute";
      await access(bun, constants.X_OK);
    }
    return undefined;
  } catch (cause) {
    return String(cause);
  }
})();
const runtimes: [string, string][] = [["Node", node]];
if (bun !== undefined) runtimes.push(["Bun", bun]);
const cases = runtimes.flatMap(([name, runtime]) =>
  (["direct", "seatbelt"] as const).map((backend) => ({ name, runtime, backend })),
);

// This script owns the actual executor in the selected host runtime. Its children
// use fixed native commands, so a Bun label cannot merely mean a Bun guest child.
async function remainingFixtureLeaders(cwd: string): Promise<string[]> {
  const remaining: string[] = [];
  for (const file of (await readdir(cwd)).filter((name) => name.startsWith("ready-"))) {
    const pid = Number(await readFile(path.join(cwd, file), "utf8"));
    if (!Number.isSafeInteger(pid) || pid <= 1) {
      remaining.push(file);
      continue;
    }
    try {
      process.kill(pid, 0);
      remaining.push(file);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    }
  }
  return remaining;
}

const hostSource = String.raw`
import assert from 'node:assert/strict';
import {access,readFile,readdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createDirectExecutor,createSeatbeltExecutor} from './runtime.mjs';
const input=JSON.parse(process.argv[2]);
const {cwd,backend,scenario,toolBundle}=input;
const create=backend==='seatbelt'?createSeatbeltExecutor:createDirectExecutor;
const owned=[];
const pending=[];
const releases=new Set();
let assertions=0;
const check=(condition,message)=>{assert.ok(condition,message);assertions++};
const track=p=>{const result=p.then(value=>({value}),error=>({error}));pending.push(result);return result};
const exists=file=>access(file).then(()=>true,()=>false);
const until=async(predicate,label)=>{const deadline=Date.now()+12000;while(Date.now()<deadline){if(await predicate())return;await delay(10)}throw Error('readiness deadline: '+label)};
const make=async(limits)=>{const e=await create({cwd,toolBundle,limits,...(backend==='seatbelt'?{deniedPaths:[join(cwd,'protected')]}:{}),...(backend==='direct'?{ambientEnvironment:{HOME:cwd,PATH:'/usr/bin:/bin'}}:{})});owned.push(e);return e};
const shell=(script,...args)=>['/bin/sh','-c',script,'fixture',...args];
const gate=(name)=>{
 const ready=join(cwd,'ready-'+name),release=join(cwd,'release-'+name);
 releases.add(release);
 return {ready,release,request:{argv:shell('printf "%s" "$$" > "$1"; n=0; while ! test -f "$2"; do n=$((n+1)); test "$n" -lt 1500 || exit 79; /bin/sleep 0.02; done; printf "%s" "$3"',ready,release,name)}};
};
const diagnostics=e=>e?JSON.stringify({code:e.code,message:e.message,cause:e.cause&&{code:e.cause.code,message:e.cause.message}}):'';
try {
 const e=await make();
 if(scenario==='overlap') {
   const gates=Array.from({length:72},(_,i)=>gate('parallel-'+i));
   const results=gates.map(g=>track(e.execute(g.request)));
   await until(async()=> (await Promise.all(gates.map(g=>exists(g.ready)))).every(Boolean),'all 72 commands running before release');
   check((await Promise.all(gates.map(g=>readFile(g.ready,'utf8')))).every(pid=>/^\d+$/.test(pid)),'72 actual native leaders');
   await Promise.all(gates.map(g=>writeFile(g.release,'')));
   const values=await Promise.all(results);
   values.forEach((r,i)=>{check(!r.error,diagnostics(r.error));check(r.value.exitCode===0&&r.value.stdout.toString()==='parallel-'+i,'independent result '+i)});
 } else if(['cancel','timeout','overflow','callback','spawn'].includes(scenario)) {
   const peer=gate('peer');
   let peerSettled=false;
   const peerResult=track(e.execute(peer.request)).then(r=>{peerSettled=true;return r});
   await until(()=>exists(peer.ready),'peer active');
   const victim=gate('victim');
   const controller=new AbortController();
   let request=victim.request;
   const options={signal:controller.signal};
   if(scenario==='timeout')request={...request,timeoutMs:500};
   if(scenario==='overflow'||scenario==='callback') {
     request={argv:shell('printf "%s" "$$" > "$1"; printf overflow-output; n=0; while ! test -f "$2"; do n=$((n+1)); test "$n" -lt 1500 || exit 79; /bin/sleep 0.02; done',victim.ready,victim.release),maxOutputBytes:scenario==='overflow'?2:1024};
     if(scenario==='callback')options.onStdout=()=>{throw Error('fixture callback failure')};
   }
   if(scenario==='spawn')request={argv:[join(cwd,'missing-executable')]};
   const victimResult=track(e.execute(request,options));
   if(scenario==='cancel'){await until(()=>exists(victim.ready),'victim active');controller.abort()}
   const failed=await victimResult;
   if(scenario==='spawn'&&backend==='seatbelt')check(failed.value?.exitCode!==0,'Seatbelt launcher reports requested executable failure');
   else {
     const expected={cancel:'sandbox_aborted',timeout:'sandbox_timeout',overflow:'sandbox_output_limit_exceeded',callback:'sandbox_process_failed',spawn:'sandbox_process_failed'}[scenario];
     check(failed.error?.code===expected,'request-local failure '+diagnostics(failed.error));
     check(failed.error?.cause?.code!=='EPERM','active group signalling must succeed: '+diagnostics(failed.error));
   }
   check(!peerSettled,'unrelated gated peer remains active after '+scenario);
   await writeFile(peer.release,'');
   const survived=await peerResult;
   check(!survived.error,diagnostics(survived.error));
   check(survived.value.exitCode===0&&survived.value.stdout.toString()==='peer','peer survived '+scenario);
   if(scenario!=='spawn'){
     const pid=Number(await readFile(victim.ready,'utf8'));
     await until(()=>{try{process.kill(pid,0);return false}catch(error){if(error.code==='ESRCH')return true;throw error}},'victim leader terminated');
     assertions++;
   }
 } else if(scenario==='limits-binary') {
   const cap=await make({maximumTimeoutMs:1000});
   const sleeping=gate('capped');
   const failed=await track(cap.execute(sleeping.request));
   check(failed.error?.code==='sandbox_timeout','omitted caller timeout uses administrator maximum: '+diagnostics(failed.error));
   const marker=join(cwd,'over-cap-started');
   const rejected=await track(cap.execute({argv:shell('printf bad > "$1"',marker),timeoutMs:1001}));
   check(rejected.error?.code==='sandbox_invalid_request','over-cap request rejected');
   check(!(await exists(marker)),'over-cap command did not launch');
   const explicit=await e.execute({argv:shell('printf long-timeout-accepted'),timeoutMs:3_600_000});
   check(explicit.exitCode===0&&explicit.stdout.toString()==='long-timeout-accepted','explicit timeout beyond ten minutes');
   const bytes=Buffer.from(Array.from({length:65536},(_,i)=>i%256));
   const chunks=[];
   const binary=await e.execute({argv:['/bin/cat'],stdin:bytes},{onStdout:chunk=>{chunks.push(chunk)}});
   check(binary.stdout.equals(bytes)&&Buffer.concat(chunks).equals(bytes),'binary input/output survives actual owner runtime');
 } else if(scenario==='startup-close') {
   const pre=gate('pre-aborted');
   const controller=new AbortController();controller.abort();
   const aborted=await track(e.execute(pre.request,{signal:controller.signal}));
   check(aborted.error?.code==='sandbox_aborted','prelaunch cancellation');
   check(!(await exists(pre.ready)),'cancelled request never starts');
   const gates=Array.from({length:12},(_,i)=>gate('close-'+i));
   const results=gates.map(g=>track(e.execute(g.request)));
   await e.close();
   const values=await Promise.all(results);
   values.forEach(r=>check(r.error?.code==='sandbox_closed','close catches request admitted during preparation: '+diagnostics(r.error)));
   const closed=await track(e.execute({argv:shell('exit 0')}));
   check(closed.error?.code==='sandbox_closed','closed executor refuses later launch');
 } else if(scenario==='survivors'||scenario==='post-exit-cancel') {
   function descendant(marker,ready,protectedFile,noisy) {
     const fs=require('node:fs');
     fs.writeFileSync(ready,String(process.pid));
     process.stdout.on('error',()=>{});
     const output=noisy?setInterval(()=>process.stdout.write('continuing-output\\n'),20):undefined;
     setTimeout(()=>{
       if(output)clearInterval(output);
       let confined=false;
       try{fs.readFileSync(protectedFile)}catch(error){confined=error.code==='EPERM'}
       fs.writeFileSync(marker,confined?'original-grants':'FAILED');
     },1000);
   }
   function launch(childSource,detached,leaderReady,childReady,noisy) {
     const fs=require('node:fs');
     const child=require('node:child_process').spawn(process.execPath,['-e',childSource],{detached,stdio:noisy?['ignore',1,2]:'ignore'});
     child.unref();
     fs.writeFileSync(leaderReady,String(process.pid));
     const timer=setInterval(()=>{if(fs.existsSync(childReady))clearInterval(timer)},5);
   }
   for(const detached of scenario==='survivors'?[false,true]:[false]) {
     const current=detached?await make():e;
     const marker=join(cwd,'survived-'+detached),leaderReady=join(cwd,'ready-leader-'+detached),childReady=join(cwd,'ready-child-'+detached);
     const noisy=scenario==='post-exit-cancel';
     const childSource='('+descendant.toString()+')('+[marker,childReady,join(cwd,'protected/marker'),noisy].map(v=>JSON.stringify(v)).join(',')+')';
     const launcher='('+launch.toString()+')('+[childSource,detached,leaderReady,childReady,noisy].map(v=>JSON.stringify(v)).join(',')+')';
     const controller=new AbortController();
     let settled=false;
     const result=track(current.execute({argv:[process.execPath,'-e',launcher]},{signal:controller.signal})).then(r=>{settled=true;return r});
     await until(()=>exists(childReady),'finite descendant active');
     const leader=Number(await readFile(leaderReady,'utf8'));
     await until(()=>{try{process.kill(leader,0);return false}catch(error){if(error.code==='ESRCH')return true;throw error}},'foreground leader exited');
     if(noisy){
       check(!settled,'continuous descendant output delays completion');
       controller.abort();
       const cancelled=await result;
       check(cancelled.error?.code==='sandbox_aborted','post-exit cancellation settles');
     } else {
       const completed=await result;
       check(!completed.error&&completed.value.exitCode===0,'foreground completed independently');
     }
     await current.close();
     check(!(await exists(marker)),'descendant still pending after foreground completion/cancel and close');
     await until(()=>exists(marker),'finite survivor after completion/cancel/close');
     check(await readFile(marker,'utf8')==='original-grants','survivor retains original confinement');
   }
 } else throw Error('unknown fixture');
} finally {
 await Promise.all([...releases].map(file=>writeFile(file,'')));
 await Promise.all(owned.map(e=>e.close()));
 await Promise.all(pending);
 // Only fixture-owned PID files are inspected. No signals or process-tree sweeps.
 const files=(await readdir(cwd)).filter(name=>name.startsWith('ready-'));
 await until(async()=>{
   for(const file of files){const pid=Number(await readFile(join(cwd,file),'utf8'));try{process.kill(pid,0);return false}catch(error){if(error.code!=='ESRCH')throw error}}
   return true;
 },'all fixture leaders exited');
}
console.log(JSON.stringify({backend,scenario,assertions,ownerRuntime:process.versions.bun?'Bun':'Node',cleanup:'all fixture leaders exited'}));
`;

it("requires native parallel-command prerequisites when Seatbelt qualification is requested", () => {
  if (process.env.PI_SANDBOX_REQUIRE_SEATBELT === "1") {
    expect(prerequisite).toBeUndefined();
    expect(bun, "supply the verified Bun release runtime").toBeTruthy();
  }
});

describe.skipIf(prerequisite !== undefined)("native concurrent command owners", () => {
  let root: string;
  let script: string;
  let retainFixtureState = false;
  beforeAll(async () => {
    root = await realpath(await mkdtemp("/private/tmp/pi-parallel-native-"));
    script = path.join(root, "host.mjs");
    await build({
      stdin: {
        contents:
          'export {createSeatbeltExecutor} from "./seatbelt-executor.ts"; export {createDirectExecutor} from "./direct-executor.ts";',
        resolveDir: path.resolve("packages/sandbox-extension/src/runtime"),
      },
      outfile: path.join(root, "runtime.mjs"),
      platform: "node",
      target: "node24",
      format: "esm",
      bundle: true,
    });
    await writeFile(script, hostSource);
  });
  afterAll(async () => {
    if (!retainFixtureState) await rm(root, { recursive: true, force: true });
  });
  for (const scenario of [
    "overlap",
    "cancel",
    "timeout",
    "overflow",
    "callback",
    "spawn",
    "limits-binary",
    "startup-close",
    "survivors",
    "post-exit-cancel",
  ]) {
    it.each(
      scenario === "survivors" || scenario === "post-exit-cancel"
        ? cases.filter(({ backend }) => backend === "seatbelt")
        : cases,
    )(
      `$name owns $backend ${scenario}`,
      async ({ name, runtime, backend }) => {
        const cwd = await mkdtemp(path.join(root, "case-"));
        await mkdir(path.join(cwd, "home"));
        await mkdir(path.join(cwd, "protected"));
        await writeFile(path.join(cwd, "protected/marker"), "private fixture");
        try {
          const result = await executeHost(
            runtime,
            [script, JSON.stringify({ cwd, backend, scenario, toolBundle })],
            {
              env: { HOME: path.join(cwd, "home"), PATH: "/usr/bin:/bin" },
              timeout: 30_000,
              maxBuffer: 1024 * 1024,
            },
          );
          const receipt = JSON.parse(result.stdout.trim()) as {
            ownerRuntime: string;
            cleanup: string;
            assertions: number;
          };
          expect(receipt.ownerRuntime).toBe(name);
          expect(receipt.cleanup).toBe("all fixture leaders exited");
          expect(receipt.assertions).toBeGreaterThan(0);
          expect(result.stderr).toBe("");
        } finally {
          // Release every possible fixture gate even if the owner fails before its
          // own finally block. Never signal a stale PID or sweep host processes.
          const names = [
            ...Array.from({ length: 72 }, (_, i) => `parallel-${i}`),
            ...Array.from({ length: 12 }, (_, i) => `close-${i}`),
            "peer",
            "victim",
            "capped",
            "pre-aborted",
          ];
          await Promise.all(names.map((name) => writeFile(path.join(cwd, `release-${name}`), "")));
          const deadline = Date.now() + 5_000;
          let remaining: string[];
          do {
            remaining = await remainingFixtureLeaders(cwd);
            if (remaining.length === 0) break;
            await new Promise<void>((resolve) => setTimeout(resolve, 10));
          } while (Date.now() < deadline);
          if (remaining.length > 0) retainFixtureState = true;
          expect(remaining, "fixture leaders must exit before removing their storage").toEqual([]);
          await rm(cwd, { recursive: true, force: true });
        }
      },
      35_000,
    );
  }
});
