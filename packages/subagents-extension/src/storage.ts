import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  readSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SubagentSnapshot } from "./contracts.js";
import { MAXIMUM_REPORT_BYTES, readBoundedFile } from "./bounds.js";
import { isProcessIdentity, previousOwnerIsDead, processIdentity } from "./owner.js";

const MAXIMUM_STATE_BYTES = 64 * 1024 * 1024;
const owners = new Set<string>();
const ID = /^[a-zA-Z0-9_-]{1,128}$/u;
const RECORD_FIELDS = new Set([
  "id",
  "taskId",
  "parentSessionId",
  "task",
  "extended",
  "status",
  "activity",
  "tools",
  "startedAt",
  "finishedAt",
  "updatedAt",
  "assistant",
  "thinking",
  "assistantTruncated",
  "thinkingTruncated",
  "result",
  "resultBytes",
  "error",
  "callback",
  "cancelRequestedBy",
  "sessionFile",
  "provider",
  "model",
  "reasoning",
]);
const STATUSES = new Set([
  "starting",
  "running",
  "stopping",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
export interface StoredSubagents {
  readonly version: 2;
  readonly used: number;
  readonly records: readonly SubagentSnapshot[];
}

export class SubagentStore {
  public readonly directory: string;
  private readonly stateFile: string;
  private readonly lockFile: string;
  private readonly token = randomUUID();
  public constructor(
    root: string,
    public readonly parentSessionId: string,
  ) {
    if (!ID.test(parentSessionId)) throw new Error("Invalid parent session identity");
    const directory = join(root, parentSessionId);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    // Resolve once before deriving any identity or persisted path. Creation,
    // resume and retention must agree when the state root has symlink ancestors.
    this.directory = realpathSync(directory);
    this.stateFile = join(this.directory, "state.json");
    this.lockFile = join(this.directory, "owner.json");
    chmodSync(this.directory, 0o700);
    if (owners.has(this.directory)) throw new Error("Subagent session already has an owner");
    const identity = processIdentity(process.pid);
    let reclaim: string | undefined;
    if (existsSync(this.lockFile)) {
      const old = JSON.parse(readBoundedFile(this.lockFile, 4096)) as {
        version?: unknown;
        pid?: unknown;
        token?: unknown;
        process?: unknown;
      };
      if (
        old.version !== 1 ||
        !isProcessIdentity(old.process) ||
        typeof old.pid !== "number" ||
        !Number.isSafeInteger(old.pid) ||
        old.pid <= 0 ||
        typeof old.token !== "string" ||
        !/^[a-f0-9-]{36}$/u.test(old.token)
      )
        throw new Error("Invalid subagent owner record");
      if (!previousOwnerIsDead(old.pid, old.process))
        throw new Error("Subagent session is owned by another live controller");
      // Only one contender may reclaim a particular dead ownership generation.
      // Recheck while holding that generation's gate; a stale observer must never
      // unlink the replacement owner's file. An interrupted gate fails closed.
      reclaim = join(this.directory, `reclaim-${old.token}`);
      const gate = openSync(reclaim, "wx", 0o600);
      closeSync(gate);
      try {
        const current = JSON.parse(readBoundedFile(this.lockFile, 4096)) as { token?: unknown };
        if (current.token !== old.token) throw new Error("Subagent owner changed during recovery");
        unlinkSync(this.lockFile);
      } catch (error) {
        unlinkSync(reclaim);
        throw error;
      }
    }
    try {
      const fd = openSync(this.lockFile, "wx", 0o600);
      try {
        writeFileSync(
          fd,
          JSON.stringify({ version: 1, pid: process.pid, token: this.token, process: identity }),
        );
      } finally {
        closeSync(fd);
      }
    } finally {
      if (reclaim) unlinkSync(reclaim);
    }
    owners.add(this.directory);
  }
  public sessionFile(id: string): string {
    if (!ID.test(id)) throw new Error("Invalid subagent identity");
    const path = join(this.directory, id);
    mkdirSync(path, { recursive: true, mode: 0o700 });
    chmodSync(path, 0o700);
    return join(path, "session.jsonl");
  }
  private resultFile(id: string, taskId: string): string {
    if (typeof id !== "string" || typeof taskId !== "string" || !ID.test(id) || !ID.test(taskId))
      throw new Error("Invalid subagent report identity");
    return join(this.directory, id, `report-${taskId}.txt`);
  }
  public writeResult(id: string, taskId: string, text: string): number {
    const path = this.resultFile(id, taskId);
    const bytes = Buffer.byteLength(text);
    if (bytes === 0 || bytes > MAXIMUM_REPORT_BYTES)
      throw new Error("Subagent report exceeds its file limit");
    this.sessionFile(id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        // Preserve the publication failure; temporary-file removal is best effort.
      }
      throw error;
    }
    return bytes;
  }
  /** Read only a requested UTF-8 range; the controller gates manifest/generation eligibility. */
  public readResult(
    id: string,
    taskId: string,
    totalBytes: number,
    offset: number,
    maximumBytes: number,
  ): string {
    const path = this.resultFile(id, taskId);
    if (!Number.isSafeInteger(totalBytes) || totalBytes <= 0 || totalBytes > MAXIMUM_REPORT_BYTES)
      throw new Error("Full subagent report is unavailable");
    if (!Number.isSafeInteger(offset) || offset < 0 || offset >= totalBytes)
      throw new Error("Invalid subagent result cursor offset");
    if (
      !Number.isSafeInteger(maximumBytes) ||
      maximumBytes <= 0 ||
      maximumBytes > MAXIMUM_REPORT_BYTES
    )
      throw new Error("Invalid subagent result page limit");
    let file: number;
    try {
      file = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    } catch {
      throw new Error("Full subagent report is unavailable");
    }
    try {
      const stat = fstatSync(file);
      if (!stat.isFile() || stat.size !== totalBytes)
        throw new Error("Full subagent report is unavailable: saved size changed");
      const buffer = Buffer.alloc(Math.min(maximumBytes + 1, totalBytes - offset));
      let length = 0;
      while (length < buffer.length) {
        const count = readSync(file, buffer, length, buffer.length - length, offset + length);
        if (count === 0) throw new Error("Full subagent report is unavailable: saved text changed");
        length += count;
      }
      const after = fstatSync(file);
      if (
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        after.ctimeMs !== stat.ctimeMs
      )
        throw new Error("Full subagent report is unavailable: saved text changed");
      if ((buffer[0]! & 0xc0) === 0x80)
        throw new Error("Invalid subagent result cursor UTF-8 offset");
      let end = Math.min(maximumBytes, length);
      while (end > 0 && end < length && (buffer[end]! & 0xc0) === 0x80) end--;
      if (end === 0) throw new Error("Subagent result page limit cannot fit a UTF-8 character");
      try {
        return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
          buffer.subarray(0, end),
        );
      } catch {
        throw new Error("Full subagent report is unavailable: invalid UTF-8");
      }
    } finally {
      closeSync(file);
    }
  }
  public removeResult(id: string, taskId: string): void {
    try {
      unlinkSync(this.resultFile(id, taskId));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  public read(): StoredSubagents {
    if (!existsSync(this.stateFile)) return { version: 2, used: 0, records: [] };
    const data: unknown = JSON.parse(readBoundedFile(this.stateFile, MAXIMUM_STATE_BYTES));
    if (!data || typeof data !== "object" || Array.isArray(data))
      throw new Error("Invalid subagent state");
    const input = data as Record<string, unknown>;
    if (
      Object.keys(input).some((key) => !["version", "used", "records"].includes(key)) ||
      input.version !== 2 ||
      typeof input.used !== "number" ||
      !Number.isSafeInteger(input.used) ||
      input.used < 0 ||
      !Array.isArray(input.records) ||
      input.records.length > 1024 ||
      input.records.length > input.used
    )
      throw new Error("Invalid subagent state");
    const seen = new Set<string>();
    const records: SubagentSnapshot[] = [];
    for (const value of input.records) {
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new Error("Invalid subagent record");
      const item = value as SubagentSnapshot;
      if (
        Object.keys(item).some((key) => !RECORD_FIELDS.has(key)) ||
        typeof item.assistantTruncated !== "boolean" ||
        typeof item.thinkingTruncated !== "boolean" ||
        !["off", "minimal", "low", "medium", "high", "xhigh"].includes(item.reasoning) ||
        typeof item.id !== "string" ||
        !ID.test(item.id) ||
        seen.has(item.id) ||
        typeof item.taskId !== "string" ||
        !ID.test(item.taskId) ||
        item.parentSessionId !== this.parentSessionId ||
        !STATUSES.has(item.status) ||
        item.sessionFile !== join(this.directory, item.id, "session.jsonl") ||
        typeof item.extended !== "boolean" ||
        !["armed", "disarmed", "acknowledged"].includes(item.callback) ||
        (item.cancelRequestedBy !== undefined && item.cancelRequestedBy !== "user") ||
        !Number.isFinite(item.startedAt) ||
        !Number.isFinite(item.updatedAt) ||
        !Array.isArray(item.tools) ||
        item.tools.length > 128 ||
        item.tools.some((tool) => typeof tool !== "string" || Buffer.byteLength(tool) > 256)
      )
        throw new Error("Invalid subagent record");
      for (const key of [
        "task",
        "activity",
        "assistant",
        "thinking",
        "provider",
        "model",
        "reasoning",
      ] as const)
        if (typeof item[key] !== "string" || Buffer.byteLength(item[key]) > 32768)
          throw new Error("Invalid subagent record text");
      if (
        Buffer.byteLength(item.activity) > 256 ||
        Buffer.byteLength(item.assistant) > 4096 ||
        Buffer.byteLength(item.thinking) > 4096 ||
        (item.result !== undefined &&
          (typeof item.result !== "string" || Buffer.byteLength(item.result) > 32768)) ||
        (item.resultBytes !== undefined &&
          (!Number.isSafeInteger(item.resultBytes) ||
            typeof item.result !== "string" ||
            item.result.length === 0 ||
            item.resultBytes < Buffer.byteLength(item.result) ||
            item.resultBytes > MAXIMUM_REPORT_BYTES ||
            !["completed", "failed", "cancelled"].includes(item.status))) ||
        (item.error !== undefined &&
          (typeof item.error !== "string" || Buffer.byteLength(item.error) > 1024)) ||
        (item.finishedAt !== undefined && !Number.isFinite(item.finishedAt))
      )
        throw new Error("Invalid subagent result");
      seen.add(item.id);
      records.push({ ...item, tools: item.tools.map((tool: string) => tool) });
    }
    return { version: 2, used: input.used, records };
  }
  public write(used: number, records: readonly SubagentSnapshot[]): void {
    const text = JSON.stringify({ version: 2, used, records });
    if (Buffer.byteLength(text) > MAXIMUM_STATE_BYTES)
      throw new Error("Subagent state exceeds its size limit");
    const temporary = `${this.stateFile}.${randomUUID()}.tmp`;
    writeFileSync(temporary, text, { mode: 0o600, flag: "wx" });
    renameSync(temporary, this.stateFile);
  }
  public close(): void {
    owners.delete(this.directory);
    if (!existsSync(this.lockFile)) return;
    const owner = JSON.parse(readBoundedFile(this.lockFile, 4096)) as { token?: string };
    if (owner.token === this.token) unlinkSync(this.lockFile);
  }
}
