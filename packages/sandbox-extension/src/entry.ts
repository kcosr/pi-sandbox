import { execFileSync } from "node:child_process";
import { realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { isWithin } from "./runtime/smolvm/options.js";
import { attachSmolvmOciMachine } from "./runtime/smolvm/oci/transport.js";
import type {
  ExtensionAPI,
  ExtensionContext,
  ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { readSandboxConfig, type SandboxExtensionConfig } from "./config.js";
import { createSandboxExtension } from "./factory.js";
import { PolicyEngine } from "./policy/policy-engine.js";
import { approvalUi } from "./policy/approval.js";
import { TOOL_NAMES } from "./policy/contracts.js";
import {
  createBubblewrapExecutor,
  createDirectExecutor,
  createSmolvmExecutor,
  type SandboxExecutor,
} from "./runtime/index.js";

interface Owner {
  readonly identity: string;
  readonly executor: SandboxExecutor;
  closed: boolean;
}
interface OwnerSlot {
  pending?: Promise<Owner> | undefined;
}
const slotKey = Symbol.for("pi-sandbox-extension.owned.v1");
const processSlots = globalThis as typeof globalThis & { [slotKey]?: OwnerSlot };

export interface EntryDependencies {
  readonly readConfig?: typeof readSandboxConfig;
  readonly create?: (config: SandboxExtensionConfig, cwd: string) => Promise<SandboxExecutor>;
  readonly canonical?: (path: string) => Promise<string>;
}

async function createExecutor(
  config: SandboxExtensionConfig,
  cwd: string,
): Promise<SandboxExecutor> {
  if (config.mode === "attached") return attachSmolvmOciMachine(config.attachment);
  const backend = config.backend;
  if (backend.kind === "direct")
    return createDirectExecutor({ cwd, environment: backend.environment });
  if (backend.kind === "smolvm")
    return createSmolvmExecutor({
      cwd,
      cwdWritable: backend.cwdWritable,
      environment: backend.environment,
      smolvmPath: backend.executable,
      imagePath: backend.image,
      imageSha256: backend.imageSha256,
      stateDirectory: backend.stateDirectory,
      resources: backend.resources,
    });
  const runtime = await realpath(backend.runtime);
  const version = execFileSync(runtime, ["--version"], {
    encoding: "utf8",
    timeout: 5000,
    maxBuffer: 1024,
  }).trim();
  const node = /^v(\d+)\./u.exec(version);
  const bun = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/u.exec(version);
  const supportedBun =
    bun &&
    (Number(bun[1]) > 1 ||
      (Number(bun[1]) === 1 &&
        (Number(bun[2]) > 3 || (Number(bun[2]) === 3 && Number(bun[3]) >= 14))));
  if (!(node && Number(node[1]) >= 24) && !supportedBun)
    throw new Error("Worker requires Node 24+ or Bun 1.3.14+");
  return createBubblewrapExecutor({
    cwd,
    bubblewrapPath: backend.executable,
    networkMode: backend.network,
    processLifetime: backend.processLifetime,
    cwdWritable: backend.cwdWritable,
    hiddenPaths: backend.hiddenPaths,
    environment: backend.environment,
    workerCommand: [runtime, fileURLToPath(new URL("./runtime/worker-entry.js", import.meta.url))],
  });
}

/** The slot is process-owned, not tied to any one conversation's extension instance. */
export function createConfiguredSandboxExtension(
  dependencies: EntryDependencies = {},
  slot: OwnerSlot = (processSlots[slotKey] ??= {}),
): ExtensionFactory {
  return async (pi: ExtensionAPI) => {
    let owner: Owner | undefined;
    let config: SandboxExtensionConfig | undefined;
    let policy: PolicyEngine | undefined;
    let active = false;
    let starting: Promise<void> | undefined;
    let ended = false;
    const getExecutor = (): SandboxExecutor => {
      if (!active || !owner || owner.closed) throw new Error("Sandbox is unavailable");
      return owner.executor;
    };
    const fail = (ctx: ExtensionContext): void => {
      active = false;
      pi.setActiveTools([]);
      ctx.ui.notify(
        "Sandbox startup failed. Check the explicit sandbox configuration and prerequisites.",
        "error",
      );
      ctx.shutdown();
    };
    pi.registerFlag("sandbox-config", {
      type: "string",
      description: "Absolute path to an explicit private sandbox JSON configuration",
    });
    await createSandboxExtension({
      cwd: process.cwd(),
      getExecutor,
      tools: TOOL_NAMES,
      userBash: () => config?.userBash === true,
      async authorize(request, ctx, signal) {
        getExecutor();
        if (!policy) throw new Error("Sandbox policy is unavailable");
        const ui = approvalUi(ctx);
        const decision = await policy.evaluate(request, {
          ...(ui ? { ui } : {}),
          ...(signal ? { signal } : {}),
        });
        if (!decision.allowed) throw new Error(`Sandbox tool denied: ${decision.reason}`);
      },
    })(pi);
    pi.on("session_start", (_event, ctx) => {
      // Pi may bind one replacement RPC session twice. Initialization is
      // idempotent for this extension instance, including concurrent binds.
      if (ended) return;
      starting ??= (async () => {
        try {
          const file = pi.getFlag("sandbox-config");
          if (typeof file !== "string" || !file) throw new Error("--sandbox-config is required");
          config = await (dependencies.readConfig ?? readSandboxConfig)(file);
          const cwd =
            config.mode === "attached"
              ? config.attachment.cwd
              : await (dependencies.canonical ?? realpath)(ctx.cwd);
          if (
            config.mode === "owned" &&
            config.backend.kind === "smolvm" &&
            isWithin(cwd, await (dependencies.canonical ?? realpath)(file))
          )
            throw new Error("Sandbox configuration must stay outside the mounted project");
          const identity = JSON.stringify({ cwd, config });
          if (!slot.pending) {
            const pending = (async () => {
              const executor = await (dependencies.create ?? createExecutor)(config, cwd);
              try {
                await executor.probe();
              } catch (error) {
                await executor.close();
                throw error;
              }
              return { identity, executor, closed: false };
            })();
            slot.pending = pending;
            void pending.catch(() => {
              if (slot.pending === pending) slot.pending = undefined;
            });
          }
          owner = await slot.pending;
          if (owner.closed || owner.identity !== identity)
            throw new Error("Reload required to change sandbox configuration or workspace");
          if (ended) return;
          policy = new PolicyEngine(config.tools);
          active = true;
          // Visibility is narrowed only for our tools; policy remains the authority.
          const admitted = config.tools;
          pi.setActiveTools(
            pi
              .getActiveTools()
              .filter(
                (name) =>
                  !TOOL_NAMES.includes(name as never) ||
                  (admitted[name as keyof typeof admitted]?.mode !== undefined &&
                    admitted[name as keyof typeof admitted]?.mode !== "disabled"),
              ),
          );
          ctx.ui.setStatus("sandbox", `${owner.executor.backend} · ${owner.executor.cwd}`);
        } catch {
          fail(ctx);
        }
      })();
      return starting;
    });
    pi.on("session_shutdown", async (event) => {
      if (ended) return;
      ended = true;
      active = false;
      policy?.clearSessionGrants();
      await starting;
      if (event.reason !== "quit" && event.reason !== "reload") return;
      // Startup may fail before this instance acquires a still-running owner
      // preserved by the outgoing conversation.
      owner ??= await slot.pending;
      if (!owner || owner.closed) return;
      owner.closed = true;
      // Keep a failed close in the slot rather than losing the only cleanup reference.
      await owner.executor.close();
      if ((await slot.pending) === owner) slot.pending = undefined;
    });
  };
}
