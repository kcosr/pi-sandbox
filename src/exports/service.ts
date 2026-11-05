import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import type { SandboxExportSource } from "../../packages/sandbox-extension/src/runtime/export/contracts.js";
import type { ExportAudit, ExportResult } from "./contracts.js";
import {
  copyExportWithProgress,
  confirmSaveBeforeQuit,
  inputExportDestination,
  reviewExport,
  selectExportFiles,
  showExportOutcome,
} from "./browser.js";
import { checkCancelled, displayPath, exportError } from "./limits.js";
import { hasExportFiles, inventoryExport } from "./manifest.js";
import { inspectExportDestination, publishExport } from "./publish.js";

export interface UserExportOptions {
  readonly cwd: string;
  readonly accountHome?: string;
  readonly getSource: () => SandboxExportSource | undefined;
  readonly admitted: () => boolean;
  readonly audit?: ExportAudit;
}

export function resolveExportDestination(input: string, cwd: string, accountHome?: string): string {
  if (input.length === 0 || input.includes("\0"))
    throw new Error("Enter a host destination directory");
  if (input === "~" || input.startsWith("~/")) {
    if (!accountHome)
      throw new Error("Your OS account home is unavailable; enter an absolute path");
    return resolve(accountHome, input === "~" ? "" : input.slice(2));
  }
  return isAbsolute(input) ? resolve(input) : resolve(cwd, input);
}

function suggestedDestination(cwd: string): string {
  const now = new Date();
  const pad = (value: number): string => String(value).padStart(2, "0");
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return resolve(cwd, "sandbox-saved", `${stamp}-${randomUUID().slice(0, 8)}`);
}

async function waitForIdle(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<void> {
  checkCancelled(signal);
  let abort: (() => void) | undefined;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () =>
      reject(signal.reason instanceof Error ? signal.reason : new Error("Sandbox save cancelled"));
    signal.addEventListener("abort", abort, { once: true });
  });
  try {
    await Promise.race([ctx.waitForIdle(), cancelled]);
  } finally {
    if (abort) signal.removeEventListener("abort", abort);
  }
}

async function checkForFiles(source: SandboxExportSource, signal: AbortSignal): Promise<boolean> {
  const controller = new AbortController();
  const scanSignal = AbortSignal.any([signal, controller.signal]);
  const timeout = setTimeout(() => controller.abort(new Error("File check timed out")), 2_000);
  timeout.unref();
  let reader: Awaited<ReturnType<SandboxExportSource["open"]>> | undefined;
  try {
    reader = await source.open(scanSignal);
    return await hasExportFiles(reader, scanSignal);
  } finally {
    clearTimeout(timeout);
    controller.abort();
    await reader?.close().catch(() => undefined);
  }
}

export function formatExportResult(result: ExportResult): string {
  const saved = result.outcomes.filter((entry) => entry.status === "saved");
  const bytes = saved.reduce((sum, entry) => sum + entry.bytes, 0);
  return (
    `${result.cancelled ? "Save cancelled" : result.error ? "Save stopped" : "Saved"}: ${saved.length} files, ${bytes} bytes to ${result.destination}.` +
    (result.error ? `; ${result.error}` : "")
  );
}

/** Application-only user workflow; the capability never enters a model-tool context. */
export function createUserExportController(options: UserExportOptions): {
  run(ctx: ExtensionCommandContext, signal?: AbortSignal): Promise<boolean>;
  beforeQuit(ctx: ExtensionCommandContext, signal: AbortSignal): Promise<boolean>;
  close(): Promise<void>;
} {
  let active: { controller: AbortController; promise: Promise<void> } | undefined;
  let closed = false;
  return {
    async beforeQuit(ctx, signal) {
      if (ctx.mode !== "tui" || closed || !options.admitted()) return true;
      if (signal.aborted || active) return false;
      const controller = new AbortController();
      const quitSignal = AbortSignal.any([signal, controller.signal]);
      let choice: "save" | "exit" | undefined;
      const promise = (async () => {
        try {
          await waitForIdle(ctx, quitSignal);
          let hasFiles = true;
          try {
            const source = options.getSource();
            if (source) hasFiles = await checkForFiles(source, quitSignal);
          } catch {
            // An incomplete check must not silently discard potentially savable files.
          }
          checkCancelled(quitSignal);
          choice = hasFiles ? await confirmSaveBeforeQuit(ctx, quitSignal) : "exit";
        } catch (error) {
          if (!quitSignal.aborted) throw error;
        }
      })();
      active = { controller, promise };
      try {
        await promise;
      } finally {
        if (active?.controller === controller) active = undefined;
      }
      if (quitSignal.aborted || choice === undefined) return false;
      if (choice === "exit") return true;
      return this.run(ctx, signal);
    },
    async run(ctx, externalSignal) {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/sandbox save requires interactive TUI mode", "warning");
        return false;
      }
      if (closed || !options.admitted()) {
        ctx.ui.notify("Sandbox saving is disabled or unavailable", "warning");
        return false;
      }
      if (active) {
        ctx.ui.notify("A sandbox save is already active", "warning");
        return false;
      }
      if (externalSignal?.aborted) return false;
      const controller = new AbortController();
      let saved = false;
      const promise = (async () => {
        const signal = externalSignal
          ? AbortSignal.any([controller.signal, externalSignal])
          : controller.signal;
        const transferController = new AbortController();
        const transferSignal = AbortSignal.any([signal, transferController.signal]);
        let reader: Awaited<ReturnType<SandboxExportSource["open"]>> | undefined;
        try {
          ctx.ui.notify("Waiting for foreground activity before saving…", "info");
          await waitForIdle(ctx, signal);
          checkCancelled(signal);
          const source = options.getSource();
          if (!source) throw new Error("Private sandbox file export is unavailable");
          reader = await source.open(transferSignal);
          const selection = await selectExportFiles(ctx, reader, signal);
          if (!selection) return;
          ctx.ui.notify("Checking selected files, including hidden descendants…", "info");
          const manifest = await inventoryExport(reader, selection, signal);
          let destination = suggestedDestination(options.cwd);
          while (true) {
            checkCancelled(signal);
            const input = await inputExportDestination(ctx, destination, signal);
            if (input === undefined) return;
            destination = resolveExportDestination(input, options.cwd, options.accountHome);
            let plan;
            try {
              plan = await inspectExportDestination(
                manifest,
                destination,
                source.writableHostPaths,
                signal,
              );
            } catch (error) {
              ctx.ui.notify(displayPath(exportError(error)), "error");
              continue;
            }
            const choice = await reviewExport(
              ctx,
              [
                `Host destination: ${destination}`,
                `${manifest.fileCount} files, ${manifest.totalBytes} bytes; directories include hidden descendants`,
                "",
                "Selected folders and files:",
                ...manifest.selections.map((entry) => `  ${entry.rootId}:/${entry.path}`),
                "",
                "Files to save:",
                ...manifest.entries.map(
                  (entry) =>
                    `  ${entry.source.rootId}:/${entry.source.path} → ${entry.outputPath}${entry.source.kind === "directory" ? "/" : ""}`,
                ),
                "",
                ...(plan.conflicts.length === 0
                  ? ["No existing files will be replaced."]
                  : [
                      `${plan.conflicts.length} existing regular files will be replaced:`,
                      ...plan.conflicts.map((entry) => `  ${entry.path}`),
                    ]),
                "",
                "Saving copies files and keeps the private originals.",
                "Cancelling can leave files that have already been saved.",
              ],
              plan.conflicts.length > 0,
              signal,
            );
            if (choice === undefined) return;
            if (choice === "destination") continue;
            const exportReader = reader;
            const result = await copyExportWithProgress(
              ctx,
              () =>
                publishExport({
                  reader: exportReader,
                  manifest,
                  destination: plan,
                  replaceListed: plan.conflicts.length > 0,
                  sessionId: ctx.sessionManager.getSessionId(),
                  ...(options.audit ? { audit: options.audit } : {}),
                  signal: transferSignal,
                }),
              () => transferController.abort(new Error("Save cancelled")),
              signal,
            );
            ctx.ui.notify(
              displayPath(formatExportResult(result)),
              result.error ? "warning" : "info",
            );
            await showExportOutcome(
              ctx,
              [
                formatExportResult(result),
                ...result.outcomes.map(
                  (entry) =>
                    `${entry.status}: ${entry.path}${entry.error ? ` — ${entry.error}` : ""}`,
                ),
              ],
              signal,
            );
            saved = result.error === undefined && !result.cancelled && !signal.aborted;
            return;
          }
        } catch (error) {
          if (!signal.aborted)
            ctx.ui.notify(`Sandbox save failed: ${displayPath(exportError(error))}`, "error");
        } finally {
          // A browser can be dismissed while a directory page is still in flight.
          transferController.abort(new Error("Sandbox save finished"));
          await reader?.close().catch(() => undefined);
        }
      })();
      active = { controller, promise };
      try {
        await promise;
        return saved;
      } finally {
        if (active?.controller === controller) active = undefined;
      }
    },
    async close() {
      closed = true;
      active?.controller.abort(new Error("Sandbox save closed"));
      await active?.promise;
    },
  };
}
