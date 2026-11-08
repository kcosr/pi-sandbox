import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SubagentStore } from "./storage.js";
import { processIdentity } from "./owner.js";
import { MAXIMUM_REPORT_BYTES } from "./bounds.js";
import type { SubagentSnapshot } from "./contracts.js";

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

function record(store: SubagentStore): SubagentSnapshot {
  return {
    id: "child",
    taskId: "task",
    parentSessionId: "parent",
    task: "a task",
    extended: false,
    status: "completed",
    activity: "completed",
    tools: [],
    startedAt: 1,
    finishedAt: 2,
    updatedAt: 2,
    assistant: "report",
    thinking: "",
    assistantTruncated: false,
    thinkingTruncated: false,
    result: "report",
    callback: "armed",
    sessionFile: store.sessionFile("child"),
    provider: "offline",
    model: "fixture",
    reasoning: "off",
  };
}

describe("saved complete subagent reports", () => {
  it("round-trips long multibyte and escaped text in bounded exact UTF-8 ranges, including BOMs", () => {
    const store = new SubagentStore(root(), "parent");
    try {
      const text = "\ufeff" + 'é中😀\n"\\\ufeff'.repeat(12_000);
      const size = store.writeResult("child", "task", text);
      expect(size).toBe(Buffer.byteLength(text));
      const file = join(store.directory, "child", "report-task.txt");
      expect(statSync(file).mode & 0o777).toBe(0o600);
      expect(readFileSync(file, "utf8")).toBe(text);
      let offset = 0;
      const pages: string[] = [];
      while (offset < size) {
        const page = store.readResult("child", "task", size, offset, 4096);
        expect(Buffer.byteLength(page)).toBeLessThanOrEqual(4096);
        expect(page.length).toBeGreaterThan(0);
        expect(store.readResult("child", "task", size, offset, 4096)).toBe(page);
        pages.push(page);
        offset += Buffer.byteLength(page);
      }
      expect(pages.join("")).toBe(text);
      expect(offset).toBe(size);
      expect(readdirSync(join(store.directory, "child"))).toEqual(["report-task.txt"]);
    } finally {
      store.close();
    }
  });

  it("rejects invalid identities, offsets, byte boundaries and page limits", () => {
    const store = new SubagentStore(root(), "parent");
    try {
      const size = store.writeResult("child", "task", "é😀tail");
      for (const [id, taskId] of [
        ["../escape", "task"],
        ["child", "../../escape"],
        ["", "task"],
      ]) {
        expect(() => store.writeResult(id!, taskId!, "x")).toThrow("identity");
        expect(() => store.readResult(id!, taskId!, size, 0, 10)).toThrow("identity");
        expect(() => store.removeResult(id!, taskId!)).toThrow("identity");
      }
      for (const offset of [-1, 1.5, size, size + 1, Number.NaN, Number.MAX_SAFE_INTEGER + 1])
        expect(() => store.readResult("child", "task", size, offset, 10)).toThrow("offset");
      for (const offset of [1, 3, 4, 5])
        expect(() => store.readResult("child", "task", size, offset, 10)).toThrow("UTF-8 offset");
      for (const maximum of [0, -1, 1.5, Number.NaN, MAXIMUM_REPORT_BYTES + 1])
        expect(() => store.readResult("child", "task", size, 0, maximum)).toThrow("page limit");
      expect(() => store.readResult("child", "task", size, 0, 1)).toThrow("cannot fit");
      expect(store.readResult("child", "task", size, 0, 2)).toBe("é");
    } finally {
      store.close();
    }
  });

  it("rejects missing, changed, invalid UTF-8, symlink and nonregular report files explicitly", () => {
    const store = new SubagentStore(root(), "parent");
    try {
      const file = join(store.directory, "child", "report-task.txt");
      expect(() => store.readResult("child", "task", 6, 0, 10)).toThrow("unavailable");
      store.writeResult("child", "task", "report");
      expect(() => store.readResult("child", "task", 7, 0, 10)).toThrow("size changed");
      writeFileSync(file, Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]));
      expect(() => store.readResult("child", "task", 6, 0, 10)).toThrow("invalid UTF-8");
      rmSync(file);
      mkdirSync(file);
      expect(() => store.readResult("child", "task", 6, 0, 10)).toThrow("unavailable");
      rmSync(file, { recursive: true });
      const elsewhere = join(store.directory, "elsewhere.txt");
      writeFileSync(elsewhere, "report");
      symlinkSync(elsewhere, file);
      expect(() => store.readResult("child", "task", 6, 0, 10)).toThrow("unavailable");
    } finally {
      store.close();
    }
  });

  it("publishes the exact ceiling, rejects overflow and cleans failed temporary writes", () => {
    const store = new SubagentStore(root(), "parent");
    try {
      const text = "x".repeat(MAXIMUM_REPORT_BYTES);
      expect(store.writeResult("child", "exact", text)).toBe(MAXIMUM_REPORT_BYTES);
      expect(
        store.readResult("child", "exact", MAXIMUM_REPORT_BYTES, MAXIMUM_REPORT_BYTES - 3, 10),
      ).toBe("xxx");
      expect(() => store.writeResult("child", "oversized", text + "x")).toThrow("file limit");
      expect(() => store.writeResult("child", "empty", "")).toThrow("file limit");
      mkdirSync(join(store.directory, "child", "report-blocked.txt"));
      expect(() => store.writeResult("child", "blocked", "report")).toThrow();
      expect(readdirSync(join(store.directory, "child")).sort()).toEqual([
        "report-blocked.txt",
        "report-exact.txt",
      ]);
      store.removeResult("child", "exact");
      store.removeResult("child", "exact");
      expect(() => store.readResult("child", "exact", MAXIMUM_REPORT_BYTES, 0, 10)).toThrow(
        "unavailable",
      );
    } finally {
      store.close();
    }
  });

  it("keeps optional report metadata in one strict v2 schema and reads it after reopening", () => {
    const directory = root();
    const store = new SubagentStore(directory, "parent");
    const value = record(store);
    try {
      store.write(1, [value]);
      expect(store.read().records[0]).toEqual(value);
      const resultBytes = store.writeResult(value.id, value.taskId, "report in full");
      store.write(1, [{ ...value, resultBytes }]);
      expect(store.read().records[0]?.resultBytes).toBe(resultBytes);
    } finally {
      store.close();
    }
    const reopened = new SubagentStore(directory, "parent");
    try {
      const saved = reopened.read();
      expect(saved.version).toBe(2);
      expect(saved.used).toBe(1);
      expect(reopened.readResult("child", "task", saved.records[0]!.resultBytes!, 0, 100)).toBe(
        "report in full",
      );
    } finally {
      reopened.close();
    }
  });

  it("rejects malformed or unsettled report metadata while accepting the exact ceiling", () => {
    const store = new SubagentStore(root(), "parent");
    try {
      const value = record(store);
      const state = join(store.directory, "state.json");
      for (const invalid of [
        { resultBytes: 0 },
        { resultBytes: -1 },
        { resultBytes: 1.5 },
        { resultBytes: "6" },
        { resultBytes: 5 },
        { resultBytes: MAXIMUM_REPORT_BYTES + 1 },
        { resultBytes: 6, result: undefined },
        { resultBytes: 6, result: "" },
        ...["starting", "running", "stopping", "interrupted"].map((status) => ({
          status,
          resultBytes: 6,
        })),
      ]) {
        writeFileSync(
          state,
          JSON.stringify({ version: 2, used: 1, records: [{ ...value, ...invalid }] }),
        );
        expect(() => store.read()).toThrow("Invalid subagent result");
      }
      for (const status of ["completed", "failed", "cancelled"] as const) {
        store.write(1, [{ ...value, status, resultBytes: MAXIMUM_REPORT_BYTES }]);
        expect(store.read().records[0]?.resultBytes).toBe(MAXIMUM_REPORT_BYTES);
      }
    } finally {
      store.close();
    }
  });
});
