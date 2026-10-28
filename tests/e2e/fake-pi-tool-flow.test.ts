import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  ExtensionAPI,
  ExtensionContext,
  UserBashEvent,
} from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
    let commandDirectory: string;
    let executor: RecordingExecutor;

    beforeAll(async () => {
      const fixtureRoot = process.env.PI_SANDBOX_TEST_TMPDIR ?? "/var/tmp";
      baseDirectory = await realpath(await mkdtemp(path.join(fixtureRoot, "pi-sandbox-kro-e2e-")));
      workspace = path.join(baseDirectory, "workspace");
      await mkdir(workspace, { mode: 0o700 });
      commandDirectory = path.join(baseDirectory, "libexec");
      await mkdir(commandDirectory, { mode: 0o700 });
      await writeFile(
        path.join(commandDirectory, "records"),
        '#!/bin/bash\n[[ "$1" == "--read" ]] || exit 20\n/bin/cat -- "$2"\n',
        { mode: 0o700 },
      );
      await writeFile(path.join(commandDirectory, "cat"), '#!/bin/bash\nprintf "shadow cat\\n"\n', {
        mode: 0o700,
      });
      await writeFile(path.join(workspace, "listed.txt"), "content\n");
      executor = new RecordingExecutor(
        await createBubblewrapExecutor({
          cwd: workspace,
          commandPathPrepend: [commandDirectory],
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
      const base = allowAllConfig();
      const config = {
        ...base,
        execution: { ...base.execution, commandPathPrepend: [commandDirectory] },
        tools: { ...base.tools, bash },
      };
      const bashAnalyzer = createConfiguredBashAnalyzer({
        config,
        cwd: workspace,
        sandboxEnvironment: config.environment.sandbox,
        ambientEnvironment: process.env,
        commandPathPrepend: [commandDirectory],
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

    const newReadOnlyCommands = [
      String.raw`grep "con\|tent" listed.txt`,
      "sed -n '/content/,/end/p' listed.txt",
      "sleep 0",
      "cd ~/ && pwd",
    ];

    const commandSets = {
      checksum_file: {
        commands: ["sha256sum"],
        mode: "allow",
        sessionGrant: "never",
        requiredFlags: ["--binary"],
        optionalFlags: [],
        options: {},
        operands: { min: 1, max: 1 },
      },
    } as const;

    it("runs configured basename/absolute alternatives with the same PATH and fixed typed tools", async () => {
      const executable = path.join(commandDirectory, "records");
      const fakePi = await start({
        audit: false,
        mode: "deny",
        sessionGrant: "never",
        commandSets: {
          read_records: {
            ...commandSets.checksum_file,
            commands: ["records", executable],
            requiredFlags: ["--read"],
          },
        },
        commandClasses: { known_read_only: { mode: "allow", sessionGrant: "never" } },
      });
      const before = bashCommands().length;
      try {
        const commands = [
          "records --read listed.txt",
          `'${executable}' --read listed.txt | head -1`,
          "cat listed.txt",
        ];
        for (const command of commands) {
          expect(resultText(await invoke(fakePi, "bash", { command }))).toBe(
            command.startsWith("cat") ? "shadow cat\n" : "content\n",
          );
        }
        for (const command of [
          "records --write listed.txt",
          `'${executable}' --read listed.txt | touch unapproved`,
        ]) {
          await expect(invoke(fakePi, "bash", { command })).rejects.toThrow("policy_denied");
        }
        expect(bashCommands().slice(before)).toEqual(commands);
        expect(resultText(await invoke(fakePi, "read", { path: "listed.txt" }))).toContain(
          "content",
        );
        expect(executor.commands.cat).not.toBe(path.join(commandDirectory, "cat"));
        expect(existsSync(path.join(workspace, "unapproved"))).toBe(false);
      } finally {
        await fakePi.emit("session_shutdown", {}, nonInteractiveContext());
      }
    });

    it("runs configured shapes and requires class approval for the remaining pipeline", async () => {
      const fakePi = await start({
        audit: false,
        mode: "deny",
        sessionGrant: "never",
        commandSets,
      });
      const before = bashCommands().length;
      try {
        expect(
          resultText(await invoke(fakePi, "bash", { command: "sha256sum --binary listed.txt" })),
        ).toMatch(/^[a-f0-9]{64} \*listed\.txt\n$/u);
        await expect(
          invoke(fakePi, "bash", { command: "sha256sum --binary listed.txt | head -1" }),
        ).rejects.toThrow("policy_denied");
        expect(bashCommands().slice(before)).toEqual(["sha256sum --binary listed.txt"]);
      } finally {
        await fakePi.emit("session_shutdown", {}, nonInteractiveContext());
      }
    });

    it("executes mixed configured pipelines but denies unsafe calls before native dispatch", async () => {
      const fakePi = await start({
        audit: false,
        mode: "deny",
        sessionGrant: "never",
        commandSets,
        commandClasses: { known_read_only: { mode: "allow", sessionGrant: "never" } },
      });
      const command = "sha256sum --binary listed.txt | head -1";
      const before = bashCommands().length;
      try {
        expect(resultText(await invoke(fakePi, "bash", { command }))).toMatch(
          /^[a-f0-9]{64} \*listed\.txt\n$/u,
        );
        for (const unsafe of [
          "sha256sum --check listed.txt | head -1",
          "sha256sum --binary listed.txt | head -1 > command-set-output",
          "sha256sum --binary listed.txt; touch command-set-output",
        ]) {
          await expect(invoke(fakePi, "bash", { command: unsafe })).rejects.toThrow(
            "policy_denied",
          );
        }
        expect(bashCommands().slice(before)).toEqual([command]);
        expect(existsSync(path.join(workspace, "command-set-output"))).toBe(false);
      } finally {
        await fakePi.emit("session_shutdown", {}, nonInteractiveContext());
      }
    });

    it("does not expose disabled Bash even with configured allow shapes", async () => {
      const fakePi = await start({
        audit: false,
        mode: "disabled",
        sessionGrant: "never",
        commandSets,
      });
      const before = bashCommands().length;
      try {
        expect(fakePi.activeTools).not.toContain("bash");
        expect(fakePi.tools.has("bash")).toBe(false);
        expect(bashCommands().length).toBe(before);
      } finally {
        await fakePi.emit("session_shutdown", {}, nonInteractiveContext());
      }
    });

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
      for (const command of newReadOnlyCommands) {
        const output = resultText(await invoke(fakePi, "bash", { command }));
        if (command.startsWith("sleep")) {
          expect(output).toBe("(no output)");
        } else {
          expect(output).toContain(command.startsWith("cd") ? "/run/pi-sandbox/home" : "content");
        }
      }
      await expect(invoke(fakePi, "bash", { command: "touch x" })).rejects.toThrow(
        'Pi Sandbox denied bash: policy_denied; not a known read-only command: "touch" is not a known read-only command',
      );
      await expect(
        invoke(fakePi, "bash", { command: "cat listed.txt >x >/dev/null" }),
      ).rejects.toThrow("not a known read-only command");
      expect(bashCommands().slice(before)).toEqual(["ls | head", ...newReadOnlyCommands]);
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
      for (const command of newReadOnlyCommands) {
        await invokeWith(fakePi, "bash", { command }, interactive);
      }
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
      expect(bashCommands().slice(before)).toEqual(["ls | head", "ls -a", ...newReadOnlyCommands]);
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
    configVersion: 13,
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
