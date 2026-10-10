import { constants } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export type McpPresentation = "direct" | "codemode" | "hidden";
export interface McpPreferencePatch {
  readonly enabled?: boolean;
  readonly exposure?: McpPresentation;
}
export interface ManagedMcpPreferences {
  readonly autoEnableCodemode: boolean;
  server(this: void, id: string): McpPreferencePatch;
  update(this: void, id: string, patch: McpPreferencePatch): Promise<void>;
}
const MAX_BYTES = 1024 * 1024;
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
async function read(path: string): Promise<Record<string, unknown>> {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error("Cannot read user MCP preferences");
  }
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error();
    const buffer = Buffer.alloc(MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_BYTES) throw new Error();
    const parsed: unknown = JSON.parse(buffer.subarray(0, size).toString("utf8"));
    if (!record(parsed) || (parsed.mcpServers !== undefined && !record(parsed.mcpServers)))
      throw new Error();
    return parsed;
  } catch {
    throw new Error("Invalid user MCP preferences");
  } finally {
    await file.close();
  }
}

/** Only presentation preferences are read. Connection definitions remain inert. */
export async function loadMcpPreferences(agentDir: string): Promise<ManagedMcpPreferences> {
  const path = join(agentDir, "mcp.json");
  let document = await read(path);
  return {
    get autoEnableCodemode() {
      return document.autoEnableCodemode !== false;
    },
    server(id) {
      const servers = document.mcpServers;
      const value = record(servers) && Object.hasOwn(servers, id) ? servers[id] : undefined;
      if (!record(value)) return {};
      return {
        ...(typeof value.enabled === "boolean" ? { enabled: value.enabled } : {}),
        ...(value.exposure === "direct" ||
        value.exposure === "codemode" ||
        value.exposure === "hidden"
          ? { exposure: value.exposure }
          : {}),
      };
    },
    async update(id, patch) {
      const latest = await read(path);
      const servers = record(latest.mcpServers) ? latest.mcpServers : {};
      const old = Object.hasOwn(servers, id) ? servers[id] : undefined;
      latest.mcpServers = {
        ...servers,
        [id]: { ...(record(old) ? old : {}), ...patch },
      };
      const text = `${JSON.stringify(latest, null, 2)}\n`;
      if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("MCP preferences exceed size limit");
      await mkdir(agentDir, { recursive: true });
      const temporary = join(agentDir, `.mcp-${randomUUID()}.tmp`);
      try {
        const file = await open(temporary, "wx", 0o600);
        try {
          await file.writeFile(text);
        } finally {
          await file.close();
        }
        await rename(temporary, path);
        document = latest;
      } finally {
        await rm(temporary, { force: true });
      }
    },
  };
}
