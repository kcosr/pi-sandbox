import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentStore } from "./storage.js";
import { processIdentity } from "./owner.js";

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const ended = once(child, "exit");
      child.kill("SIGKILL");
      await ended;
    }
  }
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function root() {
  const directory = mkdtempSync(join(tmpdir(), "subagent-store-"));
  directories.push(directory);
  return directory;
}

describe("subagent state ownership recovery", () => {
  it("reclaims a stale process instance even when that PID is now alive", () => {
    const directory = root();
    mkdirSync(join(directory, "parent"));
    const ownerFile = join(directory, "parent", "owner.json");
    const token = randomUUID();
    writeFileSync(
      ownerFile,
      JSON.stringify({
        version: 1,
        pid: process.pid,
        token,
        process: { ...processIdentity(process.pid), start: "previous-instance" },
      }),
    );
    const store = new SubagentStore(directory, "parent");
    try {
      const owner = JSON.parse(readFileSync(ownerFile, "utf8")) as {
        token: string;
        process: unknown;
      };
      expect(owner.token).not.toEqual(token);
      expect(owner.process).toEqual(processIdentity(process.pid));
      expect(() => new SubagentStore(directory, "parent")).toThrow("already has an owner");
    } finally {
      store.close();
    }
  });

  it.runIf(process.platform === "linux")(
    "refuses a live external owner and recovers after it is forcibly killed",
    async () => {
      const directory = root();
      mkdirSync(join(directory, "parent"));
      const ownerFile = join(directory, "parent", "owner.json");
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
      import {readFileSync,writeFileSync} from 'node:fs';
      import {randomUUID} from 'node:crypto';
      const stat=readFileSync('/proc/'+process.pid+'/stat','utf8');
      const start=stat.slice(stat.lastIndexOf(')')+2).split(' ')[19];
      const boot=readFileSync('/proc/sys/kernel/random/boot_id','utf8').trim();
      writeFileSync(process.argv[1],JSON.stringify({version:1,pid:process.pid,token:randomUUID(),process:{platform:'linux',boot,start}}));
      process.stdout.write('ready\\n');
      setInterval(()=>{},1000);
    `,
          ownerFile,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      children.push(child);
      await once(child.stdout, "data");
      expect(() => new SubagentStore(directory, "parent")).toThrow("another live controller");
      const ended = once(child, "exit");
      child.kill("SIGKILL");
      await ended;
      const store = new SubagentStore(directory, "parent");
      store.close();
    },
  );

  it("rejects old or malformed owner records rather than interpreting two contracts", () => {
    const directory = root();
    mkdirSync(join(directory, "parent"));
    writeFileSync(
      join(directory, "parent", "owner.json"),
      JSON.stringify({ pid: process.pid, token: randomUUID() }),
    );
    expect(() => new SubagentStore(directory, "parent")).toThrow("Invalid subagent owner record");
  });
});
