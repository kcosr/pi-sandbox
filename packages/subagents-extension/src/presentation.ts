import { randomUUID } from "node:crypto";
import {
  getMarkdownTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
  Markdown,
  matchesKey,
  stripTerminalSequences,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
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

/** Keep native Markdown styling without exposing terminal hyperlinks or control commands. */
export function safeMarkdownLine(line: string): string {
  let marker = "\ue000";
  while (line.includes(marker)) marker += "\ue000";
  const styles: string[] = [];
  const protectedStyles = line.replace(
    // SGR is the only terminal escape sequence retained from the Markdown renderer.
    // eslint-disable-next-line no-control-regex
    /\u001b\[[0-9;:]*m/gu,
    (style) => `${marker}${styles.push(style) - 1}${marker}`,
  );
  return stripTerminalSequences(protectedStyles)
    .replace(/[\p{Cc}\p{Cf}]/gu, " ")
    .replace(
      new RegExp(`${marker}(\\d+)${marker}`, "gu"),
      (_match, index: string) => styles[Number(index)] ?? "",
    );
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
    ...(agent.cancelRequestedBy === undefined
      ? {}
      : { cancelRequestedBy: agent.cancelRequestedBy }),
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
    throw new Error("Invalid subagent identity");
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
  let lastStatus: string | undefined;
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
    const color = (tone: "dim" | "accent", text: string) =>
      ctx.mode === "tui" && ctx.hasUI ? ctx.ui.theme.fg(tone, text) : text;
    const status =
      state.total === 0
        ? undefined
        : color("dim", "Subagents ") +
          color(state.active > 0 ? "accent" : "dim", `${state.active}/${state.maxConcurrent}`);
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
  pi.registerCommand("subagents-rpc", {
    description: "Subagent RPC protocol v1; JSON required. Use /subagents for the interactive menu",
    async handler(text, commandContext) {
      if (text.trim() === "" && commandContext.mode === "tui") {
        commandContext.ui.notify(
          "This command requires a JSON request. Use /subagents for the interactive menu.",
          "error",
        );
        return;
      }
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
            throw new Error("Subagent task changed or is unavailable");
          data = preview(
            request.action === "cancel"
              ? await controller.cancelByUser(selected.id, selected.taskId)
              : selected,
          );
        }
        if (disposed) return;
        pi.appendEntry(SUBAGENT_RESPONSE_ENTRY, { ...identity(), requestId, success: true, data });
      } catch (error) {
        if (disposed) return;
        const message = displayText(
          error instanceof Error ? error.message : "Observation failed",
          512,
        );
        if (commandContext.mode === "tui")
          commandContext.ui.notify(`${message}. Use /subagents for the interactive menu.`, "error");
        pi.appendEntry(SUBAGENT_RESPONSE_ENTRY, {
          ...identity(),
          ...(requestId === undefined ? {} : { requestId }),
          success: false,
          error: message,
        });
      }
    },
  });
  pi.registerCommand("subagents", {
    description: "View subagent progress and cancel a selected subagent",
    async handler(_text, commandContext) {
      if (disposed) return;
      if (commandContext.mode !== "tui") {
        commandContext.ui.notify(
          "Use the /subagents-rpc observation command for subagent state.",
          "info",
        );
        return;
      }
      if (closeView) return;
      await commandContext.ui.custom<void>(
        (tui, theme, _keys, done) => {
          let selected = 0;
          let opened: { id: string; taskId: string } | undefined;
          let scroll = 0;
          let bodyHeight = 1;
          let bodyLength = 0;
          let follow = false;
          let message = "";
          let closing = false;
          const cancelling = new Set<string>();
          const markdown = new Markdown("", 0, 0, getMarkdownTheme());
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
          const elapsed = (agent: SubagentSnapshot) => {
            const seconds = Math.max(
              0,
              Math.floor(((agent.finishedAt ?? Date.now()) - agent.startedAt) / 1000),
            );
            return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
          };
          const status = (agent: SubagentSnapshot) =>
            theme.fg(
              agent.status === "failed"
                ? "error"
                : agent.status === "completed"
                  ? "success"
                  : ACTIVE.has(agent.status)
                    ? "accent"
                    : "muted",
              agent.status,
            );
          return {
            render(width: number) {
              const agents = list();
              selected = Math.max(0, Math.min(selected, agents.length - 1));
              const stats = controller.statistics();
              const height = Math.max(1, Math.min(34, tui.terminal.rows - 2));
              bodyHeight = Math.max(1, height - 7);
              if (height < 8 || width < 16) {
                const identity = opened;
                const agent = identity
                  ? agents.find(
                      (entry) => entry.id === identity.id && entry.taskId === identity.taskId,
                    )
                  : agents[selected];
                const data = agent ? preview(agent) : undefined;
                markdown.setText(data ? (data.result ?? data.assistant) : "No subagents started");
                const body = identity
                  ? markdown.render(Math.max(1, width)).map(safeMarkdownLine)
                  : wrapTextWithAnsi(data?.task ?? "No subagents started", Math.max(1, width));
                return (
                  height === 1
                    ? ["Esc back"]
                    : [
                        theme.fg(
                          "accent",
                          theme.bold(agent ? `${agent.id} · ${agent.status}` : "Subagents"),
                        ),
                        ...body.slice(0, height - 2),
                        width < 30 ? "Esc back" : "Esc back · Resize for details",
                      ]
                ).map((line) => truncateToWidth(line, Math.max(1, width)));
              }
              const inner = Math.max(1, width - 4);
              let title = "Subagents";
              let subtitle = `${stats.active}/${stats.maxConcurrent} active · ${stats.total}/${stats.maxTotal} started`;
              let body: string[] = [];
              let position = "";
              if (opened) {
                const agent = agents.find(
                  (entry) => entry.id === opened?.id && entry.taskId === opened.taskId,
                );
                if (!agent)
                  body = [
                    theme.fg("warning", "This subagent task changed."),
                    "Press Escape to return to the list.",
                  ];
                else {
                  const data = preview(agent);
                  title = `Subagents › ${data.id}`;
                  subtitle = `${status(agent)} · ${data.extended ? "extended" : "standard"} · ${elapsed(agent)}`;
                  const output = data.result ?? data.assistant;
                  markdown.setText(output || "No assistant output yet.");
                  body = [
                    theme.fg("muted", "Assignment"),
                    ...wrapTextWithAnsi(data.task, inner),
                    "",
                    ...wrapTextWithAnsi(
                      `${data.activity}${data.tools.length ? ` · ${data.tools.join(", ")}` : ""}`,
                      inner,
                    ),
                    theme.fg(
                      "dim",
                      `Updated ${Math.max(0, Math.floor((Date.now() - data.updatedAt) / 1000))}s ago`,
                    ),
                    "",
                    theme.fg(
                      "accent",
                      theme.bold(data.result === undefined ? "Latest output" : "Result"),
                    ),
                    "",
                    ...markdown.render(inner).map(safeMarkdownLine),
                    ...(data.assistantTruncated && data.result === undefined
                      ? ["", theme.fg("dim", "Earlier output omitted from this preview.")]
                      : []),
                    ...(data.error
                      ? ["", theme.fg("error", "Error"), ...wrapTextWithAnsi(data.error, inner)]
                      : []),
                  ];
                }
                bodyLength = body.length;
                if (follow) scroll = Math.max(0, bodyLength - bodyHeight);
                scroll = Math.max(0, Math.min(scroll, Math.max(0, bodyLength - bodyHeight)));
                position =
                  bodyLength > bodyHeight
                    ? `Lines ${scroll + 1}–${Math.min(scroll + bodyHeight, bodyLength)} of ${bodyLength}${follow ? " · following" : ""}`
                    : "";
                body = body.slice(scroll, scroll + bodyHeight);
              } else {
                const visible = Math.max(1, Math.floor(bodyHeight / 3));
                const start = Math.max(0, selected - visible + 1);
                for (const [index, agent] of agents.slice(start, start + visible).entries()) {
                  const current = index + start === selected;
                  const label = displayText(agent.task, 160).replaceAll("\n", " ");
                  body.push(
                    theme.fg(
                      current ? "accent" : "text",
                      `${current ? "›" : " "} ${agent.id}  ${label}`,
                    ),
                    `  ${status(agent)} · ${agent.extended ? "extended" : "standard"} · ${elapsed(agent)} · ${displayText(agent.activity, 80).replaceAll("\n", " ")}`,
                    "",
                  );
                }
                if (!agents.length)
                  body = [theme.fg("muted", "No subagents have started in this conversation.")];
                position = agents.length ? `${selected + 1} of ${agents.length} subagents` : "";
              }
              while (body.length < bodyHeight) body.push("");
              const pad = (line: string) => {
                const clipped = truncateToWidth(line, inner);
                return clipped + " ".repeat(Math.max(0, inner - visibleWidth(clipped)));
              };
              const frame = (line: string) =>
                `${theme.fg("border", "│")} ${pad(line)} ${theme.fg("border", "│")}`;
              const hint = opened
                ? "↑↓ scroll · PgUp/PgDn · Home/End · Esc back · c cancel"
                : "↑↓ select · Enter details · Esc close · c cancel";
              const lines = [
                theme.fg("border", `╭${"─".repeat(Math.max(0, width - 2))}╮`),
                frame(theme.fg("accent", theme.bold(title))),
                frame(subtitle),
                frame(""),
                ...body.slice(0, bodyHeight).map(frame),
                frame(message ? theme.fg("warning", message) : theme.fg("dim", position)),
                frame(theme.fg("muted", hint)),
                theme.fg("border", `╰${"─".repeat(Math.max(0, width - 2))}╯`),
              ];
              return lines.map((line) => truncateToWidth(line, Math.max(1, width)));
            },
            handleInput(input: string) {
              if (closing) return;
              if (matchesKey(input, "ctrl+c")) close();
              else if (matchesKey(input, "escape")) {
                if (opened) {
                  opened = undefined;
                  scroll = 0;
                  follow = false;
                  message = "";
                } else close();
              } else if (matchesKey(input, "up")) {
                if (opened) {
                  scroll--;
                  follow = false;
                } else selected--;
              } else if (matchesKey(input, "down")) {
                if (opened) {
                  scroll++;
                  follow = false;
                } else selected++;
              } else if (opened && matchesKey(input, "pageUp")) {
                scroll -= bodyHeight;
                follow = false;
              } else if (opened && matchesKey(input, "pageDown")) {
                scroll += bodyHeight;
                follow = false;
              } else if (opened && matchesKey(input, "home")) {
                scroll = 0;
                follow = false;
              } else if (opened && matchesKey(input, "end")) {
                scroll = bodyLength;
                follow = true;
              } else if (matchesKey(input, "enter") && !opened) {
                const item = list()[selected];
                if (item) {
                  opened = { id: item.id, taskId: item.taskId };
                  scroll = 0;
                  follow = false;
                  message = "";
                }
              } else if (input === "c") {
                const selection = opened;
                const item = selection
                  ? list().find(
                      (agent) => agent.id === selection.id && agent.taskId === selection.taskId,
                    )
                  : list()[selected];
                if (item && ACTIVE.has(item.status) && !cancelling.has(item.taskId)) {
                  cancelling.add(item.taskId);
                  message = `Cancelling ${item.id}…`;
                  void controller
                    .cancelByUser(item.id, item.taskId)
                    .then((result) => {
                      if (!closing) message = `${item.id}: ${result.status}`;
                    })
                    .catch((error: unknown) => {
                      if (!closing)
                        message = displayText(
                          error instanceof Error ? error.message : "Cancellation failed",
                          200,
                        );
                    })
                    .finally(() => {
                      cancelling.delete(item.taskId);
                      if (!closing) tui.requestRender();
                    });
                }
              }
              tui.requestRender();
            },
            invalidate() {
              markdown.invalidate();
            },
            dispose() {
              closing = true;
              clearInterval(timer);
              refresh = undefined;
              closeView = undefined;
              previews.delete(controller);
            },
          };
        },
        {
          overlay: true,
          overlayOptions: () => ({ anchor: "center", width: "90%", maxHeight: "95%", margin: 1 }),
        },
      );
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
