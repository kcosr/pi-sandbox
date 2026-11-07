import { randomUUID } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { SubagentController, SubagentSnapshot } from "./contracts.js";

export const SUBAGENT_STATE_ENTRY = "pi-subagents:state";
export const SUBAGENT_RESPONSE_ENTRY = "pi-subagents:response";
const previews = new WeakMap<SubagentController, () => void>();
const ACTIVE = new Set(["starting", "running", "stopping"]);

/** Observations are terminal-safe and bounded independently of stored transcripts. */
export function displayText(value: string, bytes = 2048): string {
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, (character) => (character === "\n" ? "\n" : " "));
  if (Buffer.byteLength(clean) <= bytes) return clean;
  let length = 0;
  let result = "";
  for (const character of clean) {
    length += Buffer.byteLength(character);
    if (length > bytes - 3) break;
    result += character;
  }
  return `${result}…`;
}

function summary(agent: SubagentSnapshot) {
  return {
    id: agent.id,
    taskId: agent.taskId,
    label: displayText(agent.task, 160).replaceAll("\n", " "),
    extended: agent.extended,
    status: agent.status,
    activity: displayText(agent.activity, 160),
    startedAt: agent.startedAt,
    updatedAt: agent.updatedAt,
    ...(agent.finishedAt === undefined ? {} : { finishedAt: agent.finishedAt }),
    notifications: agent.callback,
  };
}

function observation(controller: SubagentController) {
  const agents = controller.snapshot();
  const selected = [...agents]
    .sort(
      (a, b) =>
        Number(ACTIVE.has(b.status)) - Number(ACTIVE.has(a.status)) || b.startedAt - a.startedAt,
    )
    .slice(0, 64);
  return {
    ...controller.statistics(),
    count: agents.length,
    truncated: selected.length < agents.length,
    agents: selected.map(summary),
  };
}

function preview(agent: SubagentSnapshot) {
  return {
    ...summary(agent),
    task: displayText(agent.task),
    tools: agent.tools.slice(0, 32).map((tool) => displayText(tool, 128)),
    assistant: displayText(agent.assistant, 4096),
    assistantTruncated: agent.assistantTruncated || Buffer.byteLength(agent.assistant) > 4096,
    ...(agent.result === undefined ? {} : { result: displayText(agent.result, 4096) }),
    ...(agent.error === undefined ? {} : { error: displayText(agent.error, 1024) }),
  };
}

interface ObservationRequest {
  version: 1;
  requestId: string;
  action: "snapshot" | "inspect" | "cancel";
  id?: string;
  taskId?: string;
}

export function parseObservationRequest(text: string): ObservationRequest {
  if (Buffer.byteLength(text) > 4096) throw new Error("Observation request exceeds 4096 bytes");
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an observation request object");
  const raw = value as Record<string, unknown>;
  if (
    raw.version !== 1 ||
    typeof raw.requestId !== "string" ||
    !/^[a-zA-Z0-9._:-]{1,128}$/u.test(raw.requestId)
  )
    throw new Error("Invalid observation version or requestId");
  if (raw.action !== "snapshot" && raw.action !== "inspect" && raw.action !== "cancel")
    throw new Error("Unknown observation action");
  const keys =
    raw.action === "snapshot"
      ? ["version", "requestId", "action"]
      : ["version", "requestId", "action", "id", "taskId"];
  if (
    Object.keys(raw).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(raw, key))
  )
    throw new Error("Unexpected or missing observation fields");
  if (
    raw.action !== "snapshot" &&
    [raw.id, raw.taskId].some(
      (item) =>
        typeof item !== "string" ||
        item.length === 0 ||
        item.length > 128 ||
        /[\p{Cc}\p{Cf}]/u.test(item),
    )
  )
    throw new Error("Invalid child identity");
  return raw as unknown as ObservationRequest;
}

/** Approval owners may dismiss a user preview before acquiring dialog focus. */
export function closeSubagentPreview(controller: SubagentController): void {
  previews.get(controller)?.();
}

export function attachSubagentPresentation(
  pi: ExtensionAPI,
  controller: SubagentController,
  ctx: ExtensionContext,
): { dispose(): void; closePreview(): void } {
  let disposed = false;
  let sequence = 0;
  let lastLifecycle = "";
  let lastStatus = "";
  let refresh: (() => void) | undefined;
  let closeView: (() => void) | undefined;
  const epoch = randomUUID();
  const identity = () => ({
    version: 1 as const,
    epoch,
    sequence: ++sequence,
    parentSessionId: controller.parentSessionId,
  });
  const publish = () => {
    if (disposed) return;
    const state = observation(controller);
    const all = controller.snapshot();
    const waiting = all.filter(
      (agent) => ACTIVE.has(agent.status) && /approval/iu.test(agent.activity),
    ).length;
    const failed = all.filter((agent) => agent.status === "failed").length;
    const status = `Agents: ${state.active}/${state.maxConcurrent} active${waiting ? ` · ${waiting} awaiting approval` : ""}${failed ? ` · ${failed} failed` : ""} · ${state.total}/${state.maxTotal} attempts · /agents`;
    if (status !== lastStatus) {
      ctx.ui.setStatus("subagents", status);
      lastStatus = status;
    }
    const lifecycle = JSON.stringify({
      total: state.total,
      active: state.active,
      agents: all.map((agent) => [
        agent.id,
        agent.taskId,
        agent.status,
        agent.callback,
        /approval/iu.test(agent.activity),
      ]),
    });
    // Only durable lifecycle transitions enter the parent transcript, never token deltas.
    if (lifecycle !== lastLifecycle) {
      lastLifecycle = lifecycle;
      pi.appendEntry(SUBAGENT_STATE_ENTRY, { ...identity(), ...state });
    }
    refresh?.();
  };
  pi.registerCommand("agents-rpc", {
    description: "Subagent observation protocol v1 (snapshot, inspect, cancel)",
    async handler(text) {
      let requestId: string | undefined;
      try {
        if (Buffer.byteLength(text) <= 4096) {
          const envelope: unknown = JSON.parse(text);
          if (
            envelope !== null &&
            typeof envelope === "object" &&
            "requestId" in envelope &&
            typeof envelope.requestId === "string" &&
            /^[a-zA-Z0-9._:-]{1,128}$/u.test(envelope.requestId)
          )
            requestId = envelope.requestId;
        }
        const request = parseObservationRequest(text);
        requestId = request.requestId;
        if (disposed) throw new Error("Subagent session has ended");
        let data: unknown;
        if (request.action === "snapshot") data = observation(controller);
        else {
          const selected = controller.snapshot().find((agent) => agent.id === request.id);
          if (!selected || selected.taskId !== request.taskId)
            throw new Error("Child task changed or is unavailable");
          data = preview(
            request.action === "cancel"
              ? await controller.cancel(selected.id, selected.taskId)
              : selected,
          );
        }
        if (disposed) return;
        pi.appendEntry(SUBAGENT_RESPONSE_ENTRY, { ...identity(), requestId, success: true, data });
      } catch (error) {
        if (disposed) return;
        pi.appendEntry(SUBAGENT_RESPONSE_ENTRY, {
          ...identity(),
          ...(requestId === undefined ? {} : { requestId }),
          success: false,
          error: displayText(error instanceof Error ? error.message : "Observation failed", 512),
        });
      }
    },
  });
  pi.registerCommand("agents", {
    description: "View subagent progress and cancel a selected child",
    async handler(_text, commandContext) {
      if (disposed) return;
      if (commandContext.mode !== "tui") {
        commandContext.ui.notify(
          "Use the agents-rpc observation command for subagent state.",
          "info",
        );
        return;
      }
      if (closeView) return;
      await commandContext.ui.custom<void>((tui, theme, _keys, done) => {
        let selected = 0;
        let opened: { id: string; taskId: string } | undefined;
        let scroll = 0;
        let message = "";
        let closing = false;
        const close = () => {
          if (!closing) {
            closing = true;
            done();
          }
        };
        closeView = close;
        previews.set(controller, close);
        refresh = () => tui.requestRender();
        const timer = setInterval(() => tui.requestRender(), 1000);
        timer.unref();
        const list = () => controller.snapshot();
        return {
          render(width: number) {
            const agents = list();
            selected = Math.max(0, Math.min(selected, agents.length - 1));
            const height = Math.max(5, Math.min(22, tui.terminal.rows - 6));
            let lines: string[];
            if (opened) {
              const agent = agents.find(
                (entry) => entry.id === opened?.id && entry.taskId === opened.taskId,
              );
              if (!agent) lines = ["This child task changed. Press Escape to return."];
              else {
                const data = preview(agent);
                const details = [
                  `${data.id} · ${data.status} · ${data.extended ? "extended" : "standard"}`,
                  data.task,
                  `${data.activity}${data.tools.length ? `: ${data.tools.join(", ")}` : ""}`,
                  `Last update ${Math.max(0, Math.floor((Date.now() - data.updatedAt) / 1000))}s ago`,
                  "",
                  data.assistant || "No assistant progress yet.",
                  ...(data.result ? ["", `Result: ${data.result}`] : []),
                  ...(data.error ? ["", `Error: ${data.error}`] : []),
                ];
                const wrapped = details.flatMap((line) =>
                  wrapTextWithAnsi(line, Math.max(1, width)),
                );
                scroll = Math.max(0, Math.min(scroll, Math.max(0, wrapped.length - height)));
                lines = wrapped.slice(scroll, scroll + height);
              }
            } else {
              const start = Math.max(0, selected - height + 2);
              lines = [
                theme.fg("accent", "Subagents"),
                ...agents
                  .slice(start, start + height - 1)
                  .map(
                    (agent, index) =>
                      `${start + index === selected ? ">" : " "} ${agent.id} ${displayText(agent.task, 100).replaceAll("\n", " ")} · ${displayText(agent.activity, 80)} · ${Math.max(0, Math.floor(((agent.finishedAt ?? Date.now()) - agent.startedAt) / 1000))}s`,
                  ),
              ];
              if (!agents.length) lines.push("No subagents in this session.");
            }
            return [
              ...lines,
              ...(message ? [message] : []),
              opened
                ? "↑↓ scroll · Escape back · c cancel task"
                : "↑↓ select · Enter preview · Escape close · c cancel task",
            ].map((line) => truncateToWidth(line, Math.max(1, width)));
          },
          handleInput(input: string) {
            if (matchesKey(input, "ctrl+c")) {
              close();
            } else if (matchesKey(input, "escape")) {
              if (opened) {
                opened = undefined;
                scroll = 0;
                message = "";
              } else close();
            } else if (matchesKey(input, "up")) {
              if (opened) scroll--;
              else selected--;
            } else if (matchesKey(input, "down")) {
              if (opened) scroll++;
              else selected++;
            } else if (matchesKey(input, "enter") && !opened) {
              const item = list()[selected];
              if (item) opened = { id: item.id, taskId: item.taskId };
            } else if (input === "c") {
              const selection = opened;
              const item = selection
                ? list().find(
                    (agent) => agent.id === selection.id && agent.taskId === selection.taskId,
                  )
                : list()[selected];
              if (item && ACTIVE.has(item.status))
                void controller.cancel(item.id, item.taskId).catch((error: unknown) => {
                  message = displayText(
                    error instanceof Error ? error.message : "Cancellation failed",
                    200,
                  );
                  tui.requestRender();
                });
            }
            tui.requestRender();
          },
          invalidate() {},
          dispose() {
            clearInterval(timer);
            refresh = undefined;
            closeView = undefined;
            previews.delete(controller);
          },
        };
      });
    },
  });
  const unsubscribe = controller.subscribe(publish);
  publish();
  return {
    closePreview() {
      closeView?.();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      unsubscribe();
      closeView?.();
      previews.delete(controller);
      ctx.ui.setStatus("subagents", undefined);
    },
  };
}
