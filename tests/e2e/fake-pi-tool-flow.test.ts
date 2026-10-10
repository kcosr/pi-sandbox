import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  UserBashEvent,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SandboxConfig } from "../../src/domain/index.js";
import { createPiSandboxExtension } from "../../src/extension/index.js";
import {
  createBubblewrapExecutor,
  type SandboxCommandRequest,
  type SandboxCommandResult,
  type SandboxExecutionOptions,
  type SandboxExecutor,
} from "../../packages/sandbox-extension/src/runtime/index.js";
import { testSandboxWorkerCommand } from "../helpers/sandbox-worker.js";

const BWRAP_PATH = process.env.PI_SANDBOX_BWRAP_PATH ?? "/usr/bin/bwrap";
const REAL_BWRAP_AVAILABLE = process.platform === "linux" && existsSync(BWRAP_PATH);

interface RegisteredTool {
  readonly name: string;
  execute(
    id: string,
    parameters: unknown,
    signal: AbortSignal | undefined,
    onUpdate: ((update: unknown) => void) | undefined,
    context: ExtensionContext,
  ): Promise<unknown>;
}

type EventHandler = (...arguments_: unknown[]) => unknown;
type CommandOptions = Parameters<ExtensionAPI["registerCommand"]>[1];

class FakePi {
  readonly tools = new Map<string, RegisteredTool>();
  readonly commands = new Map<string, CommandOptions>();
  readonly handlers = new Map<string, EventHandler[]>();
  activeTools: readonly string[] = [];

  readonly api = {
    registerTool: (tool: unknown): void => {
      const registered = tool as RegisteredTool;
      if (this.tools.has(registered.name)) {
        throw new Error(`duplicate_fake_tool:${registered.name}`);
      }
      this.tools.set(registered.name, registered);
    },
    registerCommand: (name: string, options: CommandOptions): void => {
      this.commands.set(name, options);
    },
    registerToolRenderer: (): void => undefined,
    on: (event: string, handler: EventHandler): void => {
      const handlers = this.handlers.get(event) ?? [];
      handlers.push(handler);
      this.handlers.set(event, handlers);
    },
    getSettings: () => ({}),
    setActiveTools: (names: readonly string[]): void => {
      this.activeTools = [...names];
    },
  } as unknown as ExtensionAPI;

  async emit(event: string, ...arguments_: unknown[]): Promise<unknown[]> {
    const results: unknown[] = [];
    for (const handler of this.handlers.get(event) ?? []) {
      results.push(await handler(...arguments_));
    }
    return results;
  }
}

class RecordingExecutor implements SandboxExecutor {
  readonly requests: SandboxCommandRequest[] = [];

  constructor(private readonly delegate: SandboxExecutor) {}

  get cwd(): string {
    return this.delegate.cwd;
  }

  get home(): string {
    return this.delegate.home;
  }

  get backend(): SandboxExecutor["backend"] {
    return this.delegate.backend;
  }

  get commands(): SandboxExecutor["commands"] {
    return this.delegate.commands;
  }

  probe(signal?: AbortSignal): Promise<void> {
    return this.delegate.probe(signal);
  }

  execute(
    request: SandboxCommandRequest,
    options?: SandboxExecutionOptions,
  ): Promise<SandboxCommandResult> {
    this.requests.push(request);
    return this.delegate.execute(request, options);
  }

  close(): Promise<void> {
    return this.delegate.close();
  }
}

describe.skipIf(!REAL_BWRAP_AVAILABLE)(
  "stock Pi extension tool routing with a fake Pi host",
  () => {
    let baseDirectory: string;
    let workspace: string;
    let fakePi: FakePi;
    let executor: RecordingExecutor;

    beforeAll(async () => {
      const fixtureRoot = process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp";
      baseDirectory = await mkdtemp(path.join(fixtureRoot, "pi-sandbox-pi-e2e-"));
      workspace = path.join(baseDirectory, "workspace");
      await mkdir(workspace, { mode: 0o700 });
      await writeFile(path.join(workspace, "input.txt"), "before\n", {
        mode: 0o600,
      });
      executor = new RecordingExecutor(
        await createBubblewrapExecutor({
          cwd: workspace,
          bubblewrapPath: BWRAP_PATH,
          workerCommand: testSandboxWorkerCommand(),
        }),
      );
      await executor.probe();

      fakePi = new FakePi();
      await createPiSandboxExtension({
        cwd: workspace,
        configPath: "/etc/pi-sandbox/config.toml",
        userStateDir: "/home/test/.pi/agent",
        loadConfig: () => Promise.resolve(allowAllConfig()),
        executor,
      })(fakePi.api);
      await fakePi.emit("session_start", {}, nonInteractiveContext());
    });

    afterAll(async () => {
      await fakePi?.emit("session_shutdown", {}, nonInteractiveContext());
      await executor?.close();
      if (baseDirectory) await rm(baseDirectory, { recursive: true, force: true });
    });

    it("registers exactly the seven replacement built-ins", () => {
      expect([...fakePi.tools.keys()].sort()).toEqual([
        "bash",
        "edit",
        "find",
        "grep",
        "ls",
        "read",
        "write",
      ]);
      expect([...fakePi.activeTools].sort()).toEqual([...fakePi.tools.keys()].sort());
      expect([...fakePi.commands.keys()]).toEqual(["sandbox"]);
    });

    it("routes all seven model tools through the sandbox executor", async () => {
      const readResult = await invoke(fakePi, "read", { path: "input.txt" });
      expect(resultText(readResult)).toContain("before");

      await invoke(fakePi, "write", {
        path: "written.txt",
        content: "created\n",
      });
      expect(await readFile(path.join(workspace, "written.txt"), "utf8")).toBe("created\n");

      await invoke(fakePi, "edit", {
        path: "input.txt",
        edits: [{ oldText: "before", newText: "after" }],
      });
      expect(await readFile(path.join(workspace, "input.txt"), "utf8")).toBe("after\n");

      expect(resultText(await invoke(fakePi, "ls", { path: "." }))).toContain("input.txt");
      expect(resultText(await invoke(fakePi, "find", { pattern: "*.txt", path: "." }))).toContain(
        "input.txt",
      );
      expect(resultText(await invoke(fakePi, "grep", { pattern: "after", path: "." }))).toContain(
        "after",
      );

      const bashResult = await invoke(fakePi, "bash", {
        command: "printf model-bash > model-bash.txt",
      });
      expect(resultText(bashResult)).not.toContain("error");
      expect(await readFile(path.join(workspace, "model-bash.txt"), "utf8")).toBe("model-bash");

      const executedCommands = executor.requests.map((request) => request.argv[0]);
      expect(executedCommands).toContain("/bin/cat");
      expect(executedCommands).toContain("/bin/sh");
      expect(executedCommands).toContain("/bin/bash");
      expect(
        executor.requests.some((request) =>
          request.argv.some((argument) => argument.includes("/usr/bin/find")),
        ),
      ).toBe(true);
      expect(
        executor.requests.some((request) =>
          request.argv.some((argument) => argument.includes("/bin/grep")),
        ),
      ).toBe(true);
    });

    it("reports a failed write over a directory and removes its temporary sibling", async () => {
      const parent = path.join(workspace, "failed-write");
      const target = path.join(parent, "directory");
      await mkdir(target, { recursive: true });
      await writeFile(path.join(target, "keep.txt"), "unchanged\n");

      await expect(
        invoke(fakePi, "write", { path: target, content: "replacement\n" }),
      ).rejects.toThrow(/directory/i);

      expect(await readFile(path.join(target, "keep.txt"), "utf8")).toBe("unchanged\n");
      expect(await readdir(target)).toEqual(["keep.txt"]);
      expect(await readdir(parent)).toEqual(["directory"]);
    });

    it("routes user shell through the same executor without host fallback", async () => {
      const event = {
        command: "printf user-shell > user-shell.txt",
        cwd: workspace,
        excludeFromContext: false,
      } as UserBashEvent;
      const [response] = await fakePi.emit("user_bash", event, nonInteractiveContext());
      const routed = response as {
        readonly result?: {
          readonly output: string;
          readonly exitCode: number;
          readonly cancelled: boolean;
          readonly truncated: boolean;
        };
      };
      expect(routed.result).toMatchObject({
        exitCode: 0,
        cancelled: false,
        truncated: false,
      });
      expect(await readFile(path.join(workspace, "user-shell.txt"), "utf8")).toBe("user-shell");
      expect(executor.requests.at(-1)?.argv).toEqual(["/bin/bash", "-c", event.command]);
    });
  },
);

// Exercise allowed model tools, so failures must come from the real filesystem boundary.
describe.skipIf(!REAL_BWRAP_AVAILABLE).each(["/var/tmp", "/tmp"])(
  "read-only model tool workspace beneath %s",
  (fixtureRoot) => {
    let workspace: string;
    let outsideDirectory: string;
    let outsideFile: string;
    let fakePi: FakePi;
    let executor: RecordingExecutor;

    beforeAll(async () => {
      workspace = await mkdtemp(path.join(fixtureRoot, "pi-sandbox-readonly-"));
      outsideDirectory = await mkdtemp("/var/tmp/pi-sandbox-readonly-outside-");
      outsideFile = path.join(outsideDirectory, "outside.txt");
      await writeFile(outsideFile, "outside-original\n");
      await writeFile(path.join(workspace, "input.txt"), "workspace-original\n");
      executor = new RecordingExecutor(
        await createBubblewrapExecutor({
          cwd: workspace,
          cwdWritable: false,
          bubblewrapPath: BWRAP_PATH,
          workerCommand: testSandboxWorkerCommand(),
        }),
      );
      await executor.probe();
      fakePi = new FakePi();
      await createPiSandboxExtension({
        cwd: workspace,
        configPath: "/etc/pi-sandbox/config.toml",
        userStateDir: "/home/test/.pi/agent",
        loadConfig: () =>
          Promise.resolve({
            ...allowAllConfig(),
            filesystem: { cwdWritable: false, hiddenPaths: [] },
          }),
        executor,
      })(fakePi.api);
      await fakePi.emit("session_start", {}, nonInteractiveContext());
    });

    afterAll(async () => {
      await fakePi?.emit("session_shutdown", {}, nonInteractiveContext());
      await executor?.close();
      if (workspace) await rm(workspace, { recursive: true, force: true });
      if (outsideDirectory) await rm(outsideDirectory, { recursive: true, force: true });
    });

    it("keeps the same-path CWD readable through read and allowed model Bash", async () => {
      expect(fakePi.activeTools).toContain("bash");
      expect(resultText(await invoke(fakePi, "read", { path: "input.txt" }))).toContain(
        "workspace-original",
      );
      expect(resultText(await invoke(fakePi, "bash", { command: "pwd; cat input.txt" }))).toBe(
        `${workspace}\nworkspace-original\n`,
      );
    });

    it("denies allowed model Bash writes to the CWD and other host directories", async () => {
      for (const target of [path.join(workspace, "input.txt"), outsideFile]) {
        await expect(
          invoke(fakePi, "bash", {
            command: `printf changed > '${target}'`,
          }),
        ).rejects.toThrow(/Read-only file system/i);
      }
      await expect(
        invoke(fakePi, "bash", {
          command: "printf created > new.txt",
        }),
      ).rejects.toThrow(/Read-only file system/i);
      expect(await readFile(path.join(workspace, "input.txt"), "utf8")).toBe(
        "workspace-original\n",
      );
      expect(await readFile(outsideFile, "utf8")).toBe("outside-original\n");
      expect(existsSync(path.join(workspace, "new.txt"))).toBe(false);
    });

    it("denies allowed typed write and edit without changing existing host files", async () => {
      for (const [target, oldText] of [
        [path.join(workspace, "input.txt"), "workspace-original"],
        [outsideFile, "outside-original"],
      ] as const) {
        await expect(
          invoke(fakePi, "write", {
            path: target,
            content: "replacement\n",
          }),
        ).rejects.toThrow();
        await expect(
          invoke(fakePi, "edit", {
            path: target,
            edits: [{ oldText, newText: "replacement" }],
          }),
        ).rejects.toThrow();
        expect(await readFile(target, "utf8")).toBe(`${oldText}\n`);
      }
    });

    it("keeps private temporary and runtime storage writable across tool calls", async () => {
      const marker = `${path.basename(workspace)}-private`;
      await invoke(fakePi, "bash", {
        command: `printf private-temp > /tmp/${marker}; printf private-runtime > /run/pi-sandbox/state/${marker}`,
      });
      expect(
        resultText(
          await invoke(fakePi, "bash", {
            command: `cat /tmp/${marker}; printf '\\n'; cat /run/pi-sandbox/state/${marker}`,
          }),
        ),
      ).toBe("private-temp\nprivate-runtime");
      expect(existsSync(`/tmp/${marker}`)).toBe(false);
      expect(await readFile(path.join(workspace, "input.txt"), "utf8")).toBe(
        "workspace-original\n",
      );
    });
  },
);

async function invoke(fakePi: FakePi, name: string, parameters: unknown): Promise<unknown> {
  const tool = fakePi.tools.get(name);
  if (!tool) throw new Error(`missing_fake_tool:${name}`);
  return tool.execute(`call-${name}`, parameters, undefined, undefined, nonInteractiveContext());
}

function resultText(result: unknown): string {
  const typed = result as {
    readonly content?: readonly { readonly type: string; readonly text?: string }[];
  };
  return (typed.content ?? []).map((content) => content.text ?? "").join("\n");
}

function nonInteractiveContext(): ExtensionContext {
  return { hasUI: false } as ExtensionContext;
}

function allowAllConfig(): SandboxConfig {
  const allow = { audit: false, mode: "allow", sessionGrant: "never" } as const;
  return {
    configVersion: 10,
    codemode: { enabled: false, timeoutMs: 300000 },
    mcp: { servers: {} },
    sessions: { retentionDays: 0 },
    filesystem: { cwdWritable: true, hiddenPaths: [] },
    audit: { enabled: false, facility: "local0" },
    modelsFile: "/etc/pi-sandbox/models.json",
    execution: { backend: "bubblewrap", processLifetime: "command" },
    identity: { mode: "disabled" },
    network: { mode: "none" },
    environment: { pi: {}, sandbox: {}, extensions: {} },
    extensions: {},
    tools: {
      read: allow,
      grep: allow,
      find: allow,
      ls: allow,
      write: allow,
      edit: allow,
      bash: allow,
    },
  };
}
