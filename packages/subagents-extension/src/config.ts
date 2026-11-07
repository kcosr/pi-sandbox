import { existsSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SubagentConfig } from "./contracts.js";
import { readBoundedFile } from "./bounds.js";

export const DEFAULT_TOOLS = Object.freeze(["read", "bash", "edit", "write"]);
const BUILTIN_TOOLS = new Set([...DEFAULT_TOOLS, "grep", "find", "ls", "powershell"]);
const FIELDS = new Set([
  "enabled",
  "maxConcurrent",
  "maxTotal",
  "startupTimeoutMs",
  "cancelTimeoutMs",
  "taskTimeoutMs",
  "stateDirectory",
  "tools",
]);
export const MAXIMUM_TIMER_MS = 2_147_483_647;

export function parseSubagentConfig(
  value: unknown,
  defaultDirectory = join(getAgentDir(), "subagents"),
): SubagentConfig {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Subagent configuration must be an object");
  const raw = value as Record<string, unknown>;
  if (Object.values(raw).some((entry) => entry === null))
    throw new Error("Subagent configuration values cannot be null");
  for (const key of Object.keys(raw))
    if (!FIELDS.has(key)) throw new Error(`Unknown subagent configuration field: ${key}`);
  const integer = (key: string, fallback: number, minimum: number, maximum: number) => {
    const input = raw[key] ?? fallback;
    if (
      typeof input !== "number" ||
      !Number.isSafeInteger(input) ||
      input < minimum ||
      input > maximum
    )
      throw new Error(`Invalid subagent ${key}`);
    return input;
  };
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
    throw new Error("Invalid subagent enabled");
  const directory = raw.stateDirectory ?? defaultDirectory;
  if (typeof directory !== "string" || !isAbsolute(directory) || directory.includes("\0"))
    throw new Error("Subagent stateDirectory must be absolute");
  const tools = raw.tools ?? DEFAULT_TOOLS;
  if (
    !Array.isArray(tools) ||
    tools.length > BUILTIN_TOOLS.size ||
    tools.some((tool: unknown) => typeof tool !== "string" || !BUILTIN_TOOLS.has(tool)) ||
    new Set(tools).size !== tools.length
  )
    throw new Error("Subagent tools must be distinct standard Pi tool names");
  return Object.freeze({
    enabled: raw.enabled ?? true,
    maxConcurrent: integer("maxConcurrent", 4, 1, 32),
    maxTotal: integer("maxTotal", 32, 1, 1024),
    startupTimeoutMs: integer("startupTimeoutMs", 30_000, 1, MAXIMUM_TIMER_MS),
    cancelTimeoutMs: integer("cancelTimeoutMs", 5_000, 1, MAXIMUM_TIMER_MS),
    taskTimeoutMs: integer("taskTimeoutMs", 0, 0, MAXIMUM_TIMER_MS),
    stateDirectory: directory,
    tools: Object.freeze(tools.map((tool: string) => tool)),
  });
}

export function readSubagentConfig(cwd: string, trusted: boolean): SubagentConfig {
  const path = process.env.PI_SUBAGENTS_CONFIG ?? join(cwd, ".pi", "subagents.json");
  if ((!trusted && !process.env.PI_SUBAGENTS_CONFIG) || !existsSync(path))
    return parseSubagentConfig({});
  return parseSubagentConfig(JSON.parse(readBoundedFile(path, 65_536)));
}
