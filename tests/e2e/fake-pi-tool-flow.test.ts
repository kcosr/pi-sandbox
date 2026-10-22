import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  UserBashEvent,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createManagedExtensionCatalog } from "../../src/managed-extensions/catalog.js";
import { parseConfig, projectWorkspaceMode } from "../../src/config/index.js";
import { parseSandboxArguments } from "../../src/runtime/config-arguments.js";
import type { SandboxConfig } from "../../src/domain/index.js";
import { createPiSandboxExtension } from "../../src/extension/index.js";
import { createConfiguredBashAnalyzer } from "../../src/runtime/bash-analysis.js";
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
            filesystem: { cwdWritable: false, hiddenPaths: [], deniedPaths: [] },
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

// The real analyzer, constructed as the managed runtime does, classifies commands before approval.
describe.skipIf(!REAL_BWRAP_AVAILABLE)(
  "known read-only Bash commands with the real analyzer",
  () => {
    let baseDirectory: string;
    let workspace: string;
    let executor: RecordingExecutor;

    beforeAll(async () => {
      const fixtureRoot = process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp";
      baseDirectory = await realpath(await mkdtemp(path.join(fixtureRoot, "pi-sandbox-kro-e2e-")));
      workspace = path.join(baseDirectory, "workspace");
      await mkdir(workspace, { mode: 0o700 });
      await writeFile(path.join(workspace, "listed.txt"), "content\n");
      executor = new RecordingExecutor(
        await createBubblewrapExecutor({
          cwd: workspace,
          bubblewrapPath: BWRAP_PATH,
          workerCommand: testSandboxWorkerCommand(),
        }),
      );
      await executor.probe();
    });

    afterAll(async () => {
      await executor?.close();
      if (baseDirectory) await rm(baseDirectory, { recursive: true, force: true });
    });

    async function start(bash: SandboxConfig["tools"][string]): Promise<FakePi> {
      const config = { ...allowAllConfig(), tools: { ...allowAllConfig().tools, bash } };
      const bashAnalyzer = createConfiguredBashAnalyzer({
        config,
        cwd: workspace,
        sandboxEnvironment: config.environment.sandbox,
        ambientEnvironment: process.env,
      });
      expect(bashAnalyzer).toBeDefined();
      const fakePi = new FakePi();
      await createPiSandboxExtension({
        cwd: workspace,
        configPath: "/etc/pi-sandbox/config.toml",
        userStateDir: "/home/test/.pi/agent",
        loadConfig: () => Promise.resolve(config),
        executor,
        ...(bashAnalyzer === undefined ? {} : { bashAnalyzer }),
      })(fakePi.api);
      await fakePi.emit("session_start", {}, nonInteractiveContext());
      return fakePi;
    }

    function bashCommands(): readonly string[] {
      return executor.requests
        .filter((request) => request.argv[0] === "/bin/bash")
        .map((request) => request.argv[2] ?? "");
    }

    it("runs known read-only pipelines without a prompt and explains denied commands", async () => {
      const fakePi = await start({
        audit: false,
        mode: "deny",
        sessionGrant: "never",
        commandClasses: { known_read_only: { mode: "allow", sessionGrant: "never" } },
      });
      const before = bashCommands().length;
      expect(resultText(await invoke(fakePi, "bash", { command: "ls | head" }))).toContain(
        "listed.txt",
      );
      await expect(invoke(fakePi, "bash", { command: "touch x" })).rejects.toThrow(
        'Pi Sandbox denied bash: policy_denied; not a known read-only command: "touch" is not a known read-only command',
      );
      expect(bashCommands().slice(before)).toEqual(["ls | head"]);
      expect(existsSync(path.join(workspace, "x"))).toBe(false);
      await fakePi.emit("session_shutdown", {}, nonInteractiveContext());
    });

    it("limits a class-scoped session grant to known read-only commands", async () => {
      const fakePi = await start({
        audit: false,
        mode: "ask",
        sessionGrant: "never",
        commandClasses: { known_read_only: { mode: "ask", sessionGrant: "offer" } },
      });
      const prompts: Array<{ readonly title: string; readonly choices: readonly string[] }> = [];
      const interactive = {
        hasUI: true,
        ui: {
          select: (title: string, choices: readonly string[]) => {
            prompts.push({ title, choices });
            return Promise.resolve(
              choices.includes("Allow known read-only commands for session")
                ? "Allow known read-only commands for session"
                : "Deny",
            );
          },
        },
      } as unknown as ExtensionContext;
      const before = bashCommands().length;
      await invokeWith(fakePi, "bash", { command: "ls | head" }, interactive);
      await invokeWith(fakePi, "bash", { command: "ls -a" }, interactive);
      await expect(invokeWith(fakePi, "bash", { command: "touch x" }, interactive)).rejects.toThrow(
        /^Pi Sandbox denied bash: user_denied$/u,
      );
      expect(prompts).toEqual([
        {
          title: "Allow bash (known read-only): ls | head?",
          choices: ["Allow once", "Allow known read-only commands for session", "Deny"],
        },
        { title: "Allow bash: touch x?", choices: ["Allow once", "Deny"] },
      ]);
      expect(bashCommands().slice(before)).toEqual(["ls | head", "ls -a"]);
      expect(existsSync(path.join(workspace, "x"))).toBe(false);
      await fakePi.emit("session_shutdown", {}, nonInteractiveContext());
    });
  },
);

async function invokeWith(
  fakePi: FakePi,
  name: string,
  parameters: unknown,
  context: ExtensionContext,
): Promise<unknown> {
  const tool = fakePi.tools.get(name);
  if (!tool) throw new Error(`missing_fake_tool:${name}`);
  return tool.execute(`call-${name}`, parameters, undefined, undefined, context);
}

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
    configVersion: 14,
    workspace: {
      mode: "read_write",
      default: "read_write",
      allowed: ["read_write"],
      source: "default",
    },
    codemode: { enabled: false, timeoutMs: 300000 },
    mcp: { servers: {} },
    sessions: { retentionDays: 0 },
    filesystem: { cwdWritable: true, hiddenPaths: [], deniedPaths: [] },
    audit: { enabled: false, facility: "local0" },
    modelsFile: "/etc/pi-sandbox/models.json",
    execution: { backend: "bubblewrap" },
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

describe.skipIf(!REAL_BWRAP_AVAILABLE)("one policy with startup-selected workspace modes", () => {
  it.each([undefined, "--read-only-cwd", "--writable-cwd"])(
    "enforces the matching filesystem and approval policy for %s",
    async (flag) => {
      const workspace = await realpath(await mkdtemp("/var/tmp/pi-workspace-modes-"));
      let executor: SandboxExecutor | undefined;
      let fakePi: FakePi | undefined;
      try {
        await writeFile(path.join(workspace, "input.txt"), "original");
        let source = await readFile("tests/fixtures/config.toml", "utf8");
        source = source
          .replace('cwd_default = "read_write"', 'cwd_default = "read_only"')
          .replace('cwd_allowed = ["read_write"]', 'cwd_allowed = ["read_only", "read_write"]')
          .replaceAll(
            'read_only = { mode = "ask", session_grant = "never" }',
            'read_only = { mode = "allow", session_grant = "never" }',
          );
        const args = parseSandboxArguments(flag === undefined ? [] : [flag]);
        const config = {
          ...projectWorkspaceMode(
            parseConfig(source, "mode-fixture", createManagedExtensionCatalog([])),
            args.workspaceMode,
          ),
          environment: { pi: {}, sandbox: {}, extensions: {} },
        };
        const writable = flag === "--writable-cwd";
        expect(config.workspace.mode).toBe(writable ? "read_write" : "read_only");
        expect(config.tools.bash!.mode).toBe(writable ? "ask" : "allow");
        executor = await createBubblewrapExecutor({
          cwd: workspace,
          cwdWritable: config.filesystem.cwdWritable,
          bubblewrapPath: BWRAP_PATH,
          workerCommand: testSandboxWorkerCommand(),
        });
        fakePi = new FakePi();
        await createPiSandboxExtension({
          cwd: workspace,
          configPath: "/etc/pi-sandbox/config.toml",
          userStateDir: "/home/test/.pi/agent",
          loadConfig: () => Promise.resolve(config),
          executor,
        })(fakePi.api);
        await fakePi.emit("session_start", {}, nonInteractiveContext());
        const prompts: string[] = [];
        const interactive = {
          hasUI: true,
          ui: {
            select: (title: string) => {
              prompts.push(title);
              return Promise.resolve("Allow once");
            },
          },
        } as unknown as ExtensionContext;
        if (writable) {
          await expect(
            invoke(fakePi, "bash", { command: "printf no > forbidden.txt" }),
          ).rejects.toThrow("no_ui");
          await invokeWith(fakePi, "bash", { command: "printf changed > input.txt" }, interactive);
          await invokeWith(fakePi, "write", { path: "typed.txt", content: "written" }, interactive);
          expect(await readFile(path.join(workspace, "input.txt"), "utf8")).toBe("changed");
          expect(await readFile(path.join(workspace, "typed.txt"), "utf8")).toBe("written");
          expect(prompts).toHaveLength(2);
        } else {
          await invokeWith(
            fakePi,
            "bash",
            { command: "printf scratch > /tmp/mode-scratch; cat /tmp/mode-scratch" },
            interactive,
          );
          await expect(
            invokeWith(fakePi, "bash", { command: "printf changed > input.txt" }, interactive),
          ).rejects.toThrow(/Read-only file system/i);
          await expect(
            invokeWith(fakePi, "write", { path: "typed.txt", content: "written" }, interactive),
          ).rejects.toThrow();
          expect(await readFile(path.join(workspace, "input.txt"), "utf8")).toBe("original");
          expect(prompts).toEqual([]);
        }
        expect(existsSync(path.join(workspace, "forbidden.txt"))).toBe(false);
        const summaries: string[] = [];
        await fakePi.commands
          .get("sandbox")!
          .handler("", { ui: { notify: (text: string) => summaries.push(text) } } as never);
        expect(summaries.join("\n")).toContain(config.workspace.mode);
      } finally {
        await fakePi?.emit("session_shutdown", {}, nonInteractiveContext());
        await executor?.close();
        await rm(workspace, { recursive: true, force: true });
      }
    },
    30000,
  );
});
