import {
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  truncateTail,
  type ExtensionAPI,
  type ExtensionFactory,
  type ExtensionContext,
  type ExtensionHandler,
  type ToolRenderers,
  type UserBashEvent,
  type UserBashEventResult,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { SandboxExecutionError, type SandboxExecutor } from "./runtime/index.js";
import {
  prepareSandboxToolRequest,
  type SandboxToolRequest,
  type BuiltInToolName,
  type JsonObject,
  TOOL_NAMES,
} from "./invocation.js";
import {
  executeEdit,
  executeFind,
  executeGrep,
  executeLs,
  executeRead,
  executeWrite,
  normalizeSandboxPath,
} from "./tools/executor-operations.js";

export interface SandboxExtensionOptions {
  /** Initial CWD for stock schema metadata; execution always uses the executor's canonical CWD. */
  readonly cwd: string;
  /** Must reject while the owner is starting, stopped or otherwise unavailable. */
  readonly getExecutor: () => SandboxExecutor;
  /** Immutable registration ceiling. Authorization is checked on every invocation. */
  readonly tools: readonly BuiltInToolName[];
  readonly authorize: (
    request: SandboxToolRequest,
    context: ExtensionContext,
    signal?: AbortSignal,
  ) => Promise<void>;
  /** User shell authority is independent of model-tool policy. False blocks host fallback. */
  readonly userBash?: boolean | (() => boolean);
  readonly executionScope?: string;
}

const SHELL_OUTPUT_LIMIT = 8 * 1024 * 1024;
const SHELL_UPDATE_THROTTLE_MS = 100;

interface ShellSnapshot {
  readonly output: string;
  readonly truncated: boolean;
  readonly details: { readonly truncation?: ReturnType<typeof truncateTail> } | undefined;
}

class ShellOutputCollector {
  private readonly chunks: Buffer[] = [];
  private timer: NodeJS.Timeout | undefined;
  private dirty = false;
  private lastUpdateAt = 0;

  public constructor(private readonly update?: (snapshot: ShellSnapshot) => void) {}

  public append(chunk: Buffer): void {
    this.chunks.push(Buffer.from(chunk));
    this.scheduleUpdate();
  }

  public hasOutput(): boolean {
    return this.chunks.length > 0;
  }

  public appendFallback(stdout: Buffer, stderr: Buffer): void {
    if (this.hasOutput()) return;
    if (stdout.length > 0) this.chunks.push(Buffer.from(stdout));
    if (stderr.length > 0) this.chunks.push(Buffer.from(stderr));
  }

  public finish(): ShellSnapshot {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    const snapshot = this.snapshot();
    if (this.dirty) this.update?.(snapshot);
    this.dirty = false;
    return snapshot;
  }

  private snapshot(): ShellSnapshot {
    const truncation = truncateTail(
      sanitizeShellOutput(Buffer.concat(this.chunks).toString("utf8")),
    );
    const notice = truncation.truncated
      ? `\n\n[Showing the bounded tail of command output; earlier output was discarded.]`
      : "";
    return {
      output: `${truncation.content}${notice}`,
      truncated: truncation.truncated,
      details: truncation.truncated ? { truncation } : undefined,
    };
  }

  private scheduleUpdate(): void {
    if (this.update === undefined) return;
    this.dirty = true;
    const delay = SHELL_UPDATE_THROTTLE_MS - (Date.now() - this.lastUpdateAt);
    if (delay <= 0) {
      this.emitUpdate();
      return;
    }
    this.timer ??= setTimeout(() => {
      this.timer = undefined;
      this.emitUpdate();
    }, delay);
  }

  private emitUpdate(): void {
    if (!this.dirty) return;
    this.dirty = false;
    this.lastUpdateAt = Date.now();
    this.update?.(this.snapshot());
  }
}

function sanitizeShellOutput(value: string): string {
  let output = "";
  for (let index = 0; index < value.length; index += 1) {
    const code = value.codePointAt(index);
    if (code === undefined) continue;
    if (code > 0xffff) index += 1;
    if (code === 0x1b || code === 0x9b) {
      const next = code === 0x1b ? value.codePointAt(index + 1) : 0x5b;
      if (next === 0x5d) {
        if (code === 0x1b) index += 1;
        while (index + 1 < value.length) {
          index += 1;
          const current = value.codePointAt(index);
          if (current === 0x07 || current === 0x9c) break;
          if (current === 0x1b && value.codePointAt(index + 1) === 0x5c) {
            index += 1;
            break;
          }
        }
        continue;
      }
      if (next === 0x5b) {
        if (code === 0x1b) index += 1;
        while (index + 1 < value.length) {
          index += 1;
          const current = value.codePointAt(index) ?? 0;
          if (current >= 0x40 && current <= 0x7e) break;
        }
        continue;
      }
      continue;
    }
    if (code === 0x0d) continue;
    if (code === 0x09 || code === 0x0a) output += String.fromCodePoint(code);
    else if (code > 0x1f && !(code >= 0x7f && code <= 0x9f) && !(code >= 0xfff9 && code <= 0xfffb))
      output += String.fromCodePoint(code);
  }
  return output;
}

async function authorize<T extends JsonObject>(
  options: SandboxExtensionOptions,
  subject: BuiltInToolName,
  rawArguments: T,
  ctx: ExtensionContext,
  signal?: AbortSignal,
): Promise<T> {
  const request = prepareSandboxToolRequest(subject, rawArguments);
  await options.authorize(request, ctx, signal);
  if (signal?.aborted === true) throw new SandboxExecutionError("sandbox_aborted");
  return request.arguments as T;
}

// Pi's stock edit call renderer reads the target file in this host process to preview a diff,
// before approval and outside the sandbox. Draw every edit call with the path only, including
// calls Pi renders while the edit tool is disabled and therefore unregistered.
const renderEditCall: NonNullable<ToolRenderers["renderCall"]> = (args, theme, context) => {
  const component =
    context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
  const path =
    typeof args === "object" && args !== null && "path" in args && typeof args.path === "string"
      ? args.path
      : "[invalid path]";
  component.setText(`${theme.fg("toolTitle", theme.bold("edit"))} ${theme.fg("accent", path)}`);
  return component;
};

function registerTools(pi: ExtensionAPI, options: SandboxExtensionOptions): void {
  const cwd = options.cwd;
  const enabled = new Set(options.tools);
  const executionScope = options.executionScope ?? "inside the configured execution environment";

  if (enabled.has("read")) {
    const base = withoutToolFields(createReadToolDefinition(cwd), "execute");
    pi.registerTool({
      ...base,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const executor = options.getExecutor();
        const cwd = executor.cwd;
        const args = await authorize(
          options,
          "read",
          { ...params, path: normalizeSandboxPath(cwd, params.path, executor.home) },
          ctx,
          signal,
        );
        return executeRead(executor, args, cwd, signal);
      },
    });
  }
  if (enabled.has("write")) {
    const base = withoutToolFields(createWriteToolDefinition(cwd), "execute");
    pi.registerTool({
      ...base,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const executor = options.getExecutor();
        const cwd = executor.cwd;
        const args = await authorize(
          options,
          "write",
          { ...params, path: normalizeSandboxPath(cwd, params.path, executor.home) },
          ctx,
          signal,
        );
        return executeWrite(executor, args, cwd, signal);
      },
    });
  }
  if (enabled.has("edit")) {
    // Keep every other pinned Pi definition field, including prepareArguments and the settled-result
    // renderer.
    const base = withoutToolFields(createEditToolDefinition(cwd), "execute", "renderCall");
    pi.registerTool({
      ...base,
      renderCall: renderEditCall,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const executor = options.getExecutor();
        const cwd = executor.cwd;
        const args = await authorize(
          options,
          "edit",
          { ...params, path: normalizeSandboxPath(cwd, params.path, executor.home) },
          ctx,
          signal,
        );
        return executeEdit(executor, args, cwd, signal);
      },
    });
  }
  if (enabled.has("ls")) {
    const base = withoutToolFields(createLsToolDefinition(cwd), "execute");
    pi.registerTool({
      ...base,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const executor = options.getExecutor();
        const cwd = executor.cwd;
        const args = await authorize(
          options,
          "ls",
          { ...params, path: normalizeSandboxPath(cwd, params.path ?? ".", executor.home) },
          ctx,
          signal,
        );
        return executeLs(executor, args, cwd, signal);
      },
    });
  }
  if (enabled.has("find")) {
    const base = withoutToolFields(createFindToolDefinition(cwd), "execute");
    pi.registerTool({
      ...base,
      description: `Search for files ${executionScope} using GNU find glob semantics: patterns without a slash match basenames (-name); patterns with a slash match paths relative to the search root (-path). Returns relative paths and skips .git and node_modules.`,
      promptSnippet: `Find files with GNU find glob patterns ${executionScope}`,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const executor = options.getExecutor();
        const cwd = executor.cwd;
        const args = await authorize(
          options,
          "find",
          { ...params, path: normalizeSandboxPath(cwd, params.path ?? ".", executor.home) },
          ctx,
          signal,
        );
        return executeFind(executor, args, cwd, signal);
      },
    });
  }
  if (enabled.has("grep")) {
    const base = withoutToolFields(createGrepToolDefinition(cwd), "execute");
    pi.registerTool({
      ...base,
      description: `Search file contents ${executionScope}. Returns matching lines with file paths and line numbers and skips .git directories.`,
      promptSnippet: `Search file contents ${executionScope}`,
      async execute(_id, params, signal, _onUpdate, ctx) {
        const executor = options.getExecutor();
        const cwd = executor.cwd;
        const args = await authorize(
          options,
          "grep",
          { ...params, path: normalizeSandboxPath(cwd, params.path ?? ".", executor.home) },
          ctx,
          signal,
        );
        return executeGrep(executor, args, cwd, signal);
      },
    });
  }
  if (enabled.has("bash")) {
    // Keep Pi's schema and renderers, but not its host-side OutputAccumulator, which writes
    // truncated command output to the host /tmp outside the sandbox boundary.
    const base = withoutToolFields(createBashToolDefinition(cwd), "execute");
    pi.registerTool({
      ...base,
      description: `Execute a Bash command ${executionScope}. Output is a bounded tail; earlier output is discarded rather than written to a host temporary file. Timeout defaults to 120 seconds and may be set from greater than 0 through 600 seconds.`,
      promptGuidelines: [],
      parameters: {
        ...base.parameters,
        properties: {
          ...base.parameters.properties,
          timeout: {
            ...base.parameters.properties.timeout,
            description: "Timeout in seconds (default 120, maximum 600)",
            exclusiveMinimum: 0,
            maximum: 600,
          },
        },
      },
      async execute(_id, params, signal, onUpdate, ctx) {
        const executor = options.getExecutor();
        const cwd = executor.cwd;
        const args = await authorize(options, "bash", { ...params, cwd }, ctx, signal);
        const output = new ShellOutputCollector((snapshot) => {
          onUpdate?.({
            content: [{ type: "text", text: snapshot.output }],
            details: snapshot.details,
          });
        });
        let result;
        try {
          result = await executor.execute(
            {
              argv: [executor.commands.bash, "-c", args.command],
              ...(args.timeout === undefined
                ? {}
                : { timeoutMs: bashTimeoutMilliseconds(args.timeout) }),
              maxOutputBytes: SHELL_OUTPUT_LIMIT,
            },
            {
              ...(signal === undefined ? {} : { signal }),
              onStdout: (chunk) => output.append(chunk),
              onStderr: (chunk) => output.append(chunk),
            },
          );
        } catch (error) {
          const snapshot = output.finish();
          if (signal?.aborted === true || isSandboxAbort(error))
            throw new Error(withShellStatus(snapshot.output, "Command aborted"), { cause: error });
          throw new Error(
            withShellStatus(
              snapshot.output,
              error instanceof Error ? error.message : "Sandbox command failed",
            ),
            { cause: error },
          );
        }
        output.appendFallback(result.stdout, result.stderr);
        const snapshot = output.finish();
        if (result.exitCode !== 0)
          throw new Error(
            withShellStatus(snapshot.output, `Command exited with code ${String(result.exitCode)}`),
          );
        return {
          content: [{ type: "text", text: snapshot.output || "(no output)" }],
          details: snapshot.details,
        };
      },
    });
  }
}

function withoutToolFields<T extends object, K extends keyof T>(
  source: T,
  ...keys: K[]
): Omit<T, K> {
  const copy = { ...source };
  for (const key of keys) Reflect.deleteProperty(copy, key);
  return copy;
}

function withShellStatus(output: string, status: string): string {
  return output.length > 0 ? `${output}\n\n${status}` : status;
}

function isSandboxAbort(error: unknown): boolean {
  return error instanceof SandboxExecutionError && error.code === "sandbox_aborted";
}

function bashTimeoutMilliseconds(seconds: number): number {
  if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 600) {
    throw new Error("Bash timeout must be greater than 0 and at most 600 seconds");
  }
  return Math.ceil(seconds * 1_000);
}

function failedUserShell(
  reason: string,
  options: { readonly cancelled?: boolean; readonly truncated?: boolean } = {},
): UserBashEventResult {
  return {
    result: {
      output: reason,
      exitCode: options.cancelled === true ? undefined : 1,
      cancelled: options.cancelled ?? false,
      truncated: options.truncated ?? false,
    },
  };
}

/** Compose seven sandbox-backed tools without taking ownership of their executor. */
export function createSandboxExtension(input: SandboxExtensionOptions): ExtensionFactory {
  if (typeof input.authorize !== "function") {
    throw new Error("Sandbox requires an authorization callback");
  }
  const tools = Object.freeze([...input.tools]);
  if (tools.some((tool) => !TOOL_NAMES.includes(tool)) || new Set(tools).size !== tools.length) {
    throw new Error("Sandbox tool ceiling contains an unknown or duplicate tool");
  }
  const options = Object.freeze({ ...input, tools });
  return (pi) => {
    // Even disabled edits can appear in historical sessions. Never use Pi's host-reading preview.
    pi.registerToolRenderer((toolName, next) =>
      toolName === "edit" ? { ...next(), renderCall: renderEditCall } : next(),
    );
    registerTools(pi, options);
    const userBashHandler: ExtensionHandler<UserBashEvent, UserBashEventResult> = async (
      event,
      ctx,
    ) => {
      let signal: AbortSignal | undefined;
      try {
        signal = ctx.signal;
      } catch (error) {
        return failedUserShell(
          error instanceof Error ? error.message : "Pi Sandbox user shell failed",
          { cancelled: true },
        );
      }
      try {
        const permitted =
          typeof options.userBash === "function" ? options.userBash() : options.userBash === true;
        if (!permitted) return failedUserShell("Sandbox user shell is disabled");
        const executor = options.getExecutor();
        const output = new ShellOutputCollector();
        let result;
        try {
          result = await executor.execute(
            {
              argv: [executor.commands.bash, "-c", event.command],
              maxOutputBytes: SHELL_OUTPUT_LIMIT,
            },
            {
              ...(signal === undefined ? {} : { signal }),
              onStdout: (chunk) => output.append(chunk),
              onStderr: (chunk) => output.append(chunk),
            },
          );
        } catch (error) {
          const snapshot = output.finish();
          if (signal?.aborted === true || isSandboxAbort(error)) {
            return failedUserShell(withShellStatus(snapshot.output, "Command aborted"), {
              cancelled: true,
              truncated: snapshot.truncated,
            });
          }
          return failedUserShell(
            withShellStatus(
              snapshot.output,
              error instanceof Error ? error.message : "Pi Sandbox user shell failed",
            ),
            { truncated: snapshot.truncated },
          );
        }
        output.appendFallback(result.stdout, result.stderr);
        const snapshot = output.finish();
        return {
          result: {
            output: snapshot.output,
            exitCode: result.exitCode ?? undefined,
            cancelled: false,
            truncated: snapshot.truncated,
          },
        };
      } catch (error) {
        return failedUserShell(
          error instanceof Error ? error.message : "Pi Sandbox user shell failed",
          signal?.aborted === true ? { cancelled: true } : {},
        );
      }
    };
    pi.on("user_bash", userBashHandler);
  };
}
