import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

/** Run the shipped source capability and internal reader, not a sibling source tree. */
export async function testPackagedExportSource({
  directory,
  workspace,
  deniedRoot,
  kind,
  runtime,
}) {
  const probe = join(dirname(workspace), `export-source-${basename(workspace)}.mjs`);
  await writeFile(join(deniedRoot, "export-denied-input"), "denied-host-data");
  await writeFile(
    probe,
    `
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, lstat, readFile, writeFile, access, rm } from "node:fs/promises";
import { createBubblewrapExecutor, createSeatbeltExecutor } from ${JSON.stringify(pathToFileURL(join(directory, "dist/runtime.js")).href)};
import { builtToolBundle } from ${JSON.stringify(pathToFileURL(join(directory, "dist/build-tools.js")).href)};
import { connectExportReader } from ${JSON.stringify(pathToFileURL(join(directory, "dist/runtime/export/connection.js")).href)};
import { exportIdentity } from ${JSON.stringify(pathToFileURL(join(directory, "dist/runtime/export/files.js")).href)};
import { encodeWorkerFrame } from ${JSON.stringify(pathToFileURL(join(directory, "dist/runtime/worker-protocol.js")).href)};
for (const cwdWritable of [false,true]) {
let source;
const cwdMarker=${JSON.stringify(workspace)}+"/package-export-cwd-"+cwdWritable;
const common = {cwd:${JSON.stringify(workspace)},cwdWritable,onExportSource:value=>{source=value;},...(builtToolBundle?{toolBundle:builtToolBundle}:{})};
const executor = await (${JSON.stringify(kind)} === "bubblewrap" ? createBubblewrapExecutor({...common,bubblewrapPath:"/usr/bin/bwrap",networkMode:"none",hiddenPaths:[${JSON.stringify(deniedRoot)}],workerCommand:[process.execPath,${JSON.stringify(join(directory, "dist/runtime/worker-entry.js"))}]}) : createSeatbeltExecutor({...common,networkMode:"none",deniedPaths:[${JSON.stringify(deniedRoot)}]}));
let reader;
try {
  assert(source);
  assert(!Object.hasOwn(executor,"exportSource"));
  assert.equal(source.writableHostPaths.includes(${JSON.stringify(workspace)}),cwdWritable);
  assert.equal(source.writableHostPaths.length,(${JSON.stringify(kind)}==="seatbelt"?1:0)+(cwdWritable?1:0));
  const cwdWrite=await executor.execute({argv:[executor.commands.sh,"-c",'printf workspace-data > "$1"',"package-export",cwdMarker]});
  if(cwdWritable){assert.equal(cwdWrite.exitCode,0,cwdWrite.stderr.toString());assert.equal(await readFile(cwdMarker,"utf8"),"workspace-data");}
  else {assert.notEqual(cwdWrite.exitCode,0,"read-only CWD must reject sandbox writes");await assert.rejects(access(cwdMarker));}
  const created = await executor.execute({argv:["/bin/bash","-c",'printf private-package-data > "$HOME/report"; mkdir "$HOME/nested"; printf nested > "$HOME/nested/item"; ln -s "$1/export-denied-input" "$HOME/denied-link"',"package-export",${JSON.stringify(deniedRoot)}]});
  assert.equal(created.exitCode,0,created.stderr.toString());
  reader=await source.open();
  const inventory=await reader.list("home","");
  assert.equal(inventory.entries.find(item=>item.name==="denied-link").kind,"unsupported");
  const report=inventory.entries.find(item=>item.name==="report");
  await reader.openFile(report);
  assert.equal(Buffer.from(await reader.readChunk()).toString(),"private-package-data");
  assert.equal((await reader.readChunk()).byteLength,0);
  await reader.closeFile();
  const nested=(await reader.list("home","nested")).entries.find(item=>item.name==="item");
  await executor.execute({argv:["/bin/bash","-c",'mv "$HOME/nested" "$HOME/original-nested"; ln -s "$1" "$HOME/nested"',"package-export",${JSON.stringify(deniedRoot)}]});
  await assert.rejects(reader.openFile(nested));
  await reader.close();reader=undefined;
  const controller=new AbortController();reader=await source.open(controller.signal);controller.abort();
  await assert.rejects(reader.list("home",""),/export_aborted/);
  await reader.close();reader=undefined;
  assert.equal((await executor.execute({argv:[executor.commands.sh,"-c","printf %s peer-alive"]})).stdout.toString(),"peer-alive");
  console.log("export-source-ok:"+(cwdWritable?"writable":"read-only"));
} finally {await reader?.close();await executor.close();await rm(cwdMarker,{force:true});}
}
if (${JSON.stringify(kind)} === "bubblewrap") {
  let source;
  const executor=await createBubblewrapExecutor({cwd:"/tmp",cwdWritable:true,bubblewrapPath:"/usr/bin/bwrap",networkMode:"none",workerCommand:[process.execPath,${JSON.stringify(join(directory, "dist/runtime/worker-entry.js"))}],onExportSource:value=>{source=value;}});
  let reader;
  try {
    const created=await executor.execute({argv:[executor.commands.sh,"-c",'printf private-home-data > "$HOME/report"']});
    assert.equal(created.exitCode,0,created.stderr.toString());
    assert.deepEqual(source.writableHostPaths,["/tmp"]);
    reader=await source.open();
    assert.deepEqual(reader.roots.map(root=>root.id),["home"]);
    assert((await reader.list("home","")).entries.some(entry=>entry.name==="report"));
    await assert.rejects(reader.list("tmp",""),/export_invalid_root/);
    console.log("export-source-ok:host-tmp");
  } finally {await reader?.close();await executor.close();}
}
// Exercise the shipped role and its lifecycle independently of native Seatbelt.
// This host-only probe makes no confinement claim.
const roleRoot=await mkdtemp(${JSON.stringify(join(dirname(workspace), "reader-role-"))});
let roleConnection;
try {
  const roots=[];
  for(const id of ["home","tmp"]){const path=roleRoot+"/"+id;await mkdir(path);roots.push({id,path,identity:exportIdentity(await lstat(path,{bigint:true}))});}
  await writeFile(roleRoot+"/home/report","internal-reader-data");
  const readerCommand=[${JSON.stringify(join(directory, "dist/runtime/export-reader-entry.js"))},JSON.stringify({roots})];
  const readerChild=spawn(process.execPath,readerCommand,{stdio:["pipe","pipe","pipe"]});
  roleConnection=await connectExportReader(readerChild);
  await roleConnection.request({operation:"begin"});
  const listed=await roleConnection.request({operation:"list",rootId:"home",path:""});
  assert.equal(listed.operation,"list");
  await roleConnection.request({operation:"open",entry:listed.page.entries[0]});
  const data=await roleConnection.request({operation:"read"});
  assert.equal(Buffer.from(data.data,"base64").toString(),"internal-reader-data");
  assert.equal((await roleConnection.request({operation:"read"})).data,"");
  await roleConnection.request({operation:"closeFile"});
  await roleConnection.request({operation:"end"});
  await roleConnection.close();roleConnection=undefined;
  assert.equal(readerChild.exitCode,0);
  const peer=spawn(process.execPath,["-e","setTimeout(()=>{},30000)"],{stdio:"ignore"});
  const peerClosed=new Promise(resolve=>peer.once("close",resolve));
  try {
    await once(peer,"spawn");
    const rejected=spawn(process.execPath,readerCommand,{stdio:["pipe","pipe","pipe"]});
    const rejectedClosed=once(rejected,"close");
    rejected.stdout.resume();rejected.stderr.resume();
    rejected.stdin.end(encodeWorkerFrame({type:"execute",id:1,argv:[process.execPath,"-e","require('node:fs').writeFileSync(process.argv[1],'executed')",roleRoot+"/executed"],stdin:"",maxOutputBytes:100}));
    const [code]=await rejectedClosed;
    assert.equal(code,70,"read-only role must reject execute");
    await assert.rejects(access(roleRoot+"/executed"));
    assert.equal(peer.exitCode,null,"reader cleanup must not kill another process");
  } finally {if(peer.exitCode===null)peer.kill("SIGKILL");await peerClosed;}
} finally {await roleConnection?.close();await rm(roleRoot,{recursive:true,force:true});}
`,
  );
  const output = execFileSync(runtime, [probe], {
    cwd: workspace,
    env: { PATH: process.env.PATH, HOME: deniedRoot, NO_COLOR: "1" },
    timeout: 30_000,
    maxBuffer: 64 * 1024,
    encoding: "utf8",
  });
  assert.match(output, /export-source-ok:read-only/u);
  assert.match(output, /export-source-ok:writable/u);
  if (kind === "bubblewrap") assert.match(output, /export-source-ok:host-tmp/u);
}
