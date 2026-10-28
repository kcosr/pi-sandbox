import {
  IDENTITY_BROKER_SOCKET_PATH,
  type ApprovalSubject,
  type IdentityConfig,
  type ExecutionConfig,
  type NetworkConfig,
  type SandboxConfig,
  type SubjectPolicy,
  type ToolName,
} from "../domain/index.js";
import {
  describeBubblewrapMounts,
  safeSandboxEnvironment,
} from "../../packages/sandbox-extension/src/runtime/bubblewrap-policy.js";
import {
  COMMAND_CLASS_TOOL,
  commandClassLabel,
  type CommandClassPolicy,
  type SessionGrantScope,
} from "../permissions/index.js";
import { COMMAND_CLASSES, type BashCommandAnalyzer } from "../permissions/bash/contracts.js";

export type SandboxDiagnosticSubject = string;

interface SandboxSummaryInput {
  readonly codemodeEnabled?: boolean;
  readonly mcpServerCount?: number;
  readonly initialized: boolean;
  readonly cwd: string;
  readonly configPath: string;
  readonly modelsFile: string;
  readonly filesystem: SandboxConfig["filesystem"];
  readonly execution: ExecutionConfig;
  readonly identity: IdentityConfig;
  readonly network: NetworkConfig;
  readonly extensions: readonly string[];
  readonly userStateDir: string;
}

interface PolicyDiagnosticInput {
  readonly config: SandboxConfig;
  readonly hasSessionGrant: (subject: ApprovalSubject, scope?: SessionGrantScope) => boolean;
  readonly isToolActive: (subject: ToolName) => boolean;
  readonly hostToolScopes?: Readonly<Record<string, string>>;
  readonly commandAnalyzer?: Pick<BashCommandAnalyzer, "version" | "commands">;
}

const SANDBOX_SUBJECT_SCOPES: Readonly<Record<string, readonly string[]>> = Object.freeze({
  read: ["Reads files visible inside the sandbox.", "Cannot modify the host filesystem."],
  grep: [
    "Searches file contents visible inside the sandbox.",
    "Cannot modify the host filesystem.",
  ],
  find: ["Searches file names visible inside the sandbox.", "Cannot modify the host filesystem."],
  ls: ["Lists directories visible inside the sandbox.", "Cannot modify the host filesystem."],
  write: [
    "May create or replace files inside the launch directory.",
    "May write private /tmp and /run state that disappears when pi-sandbox exits.",
    "Cannot write elsewhere on the host.",
  ],
  edit: [
    "May edit files inside the launch directory.",
    "May edit private /tmp and /run state that disappears when pi-sandbox exits.",
    "Cannot write elsewhere on the host.",
  ],
  bash: [
    "Runs model-requested Bash inside the same sandbox.",
    "May read visible host paths and write inside the launch directory and private runtime filesystems.",
    "Structured tool policies do not further restrict an approved Bash command.",
  ],
  user_shell: [
    "Runs user-invoked ! shell commands inside the same sandbox.",
    "May read visible host paths and write inside the launch directory and private runtime filesystems.",
    "Structured tool policies do not further restrict an approved shell command.",
  ],
});

export function formatSandboxSummary(input: SandboxSummaryInput): string {
  const rows: Array<readonly [string, string]> = [
    ["Launch CWD", input.cwd],
    [
      "Hidden paths",
      input.filesystem.hiddenPaths.length === 0 ? "none" : input.filesystem.hiddenPaths.join(", "),
    ],
    [
      "Denied paths",
      input.filesystem.deniedPaths.length === 0 ? "none" : input.filesystem.deniedPaths.join(", "),
    ],
    [
      "CWD access",
      input.execution.backend === "direct"
        ? "host permissions (uncontained)"
        : input.filesystem.cwdWritable
          ? "read/write"
          : "read-only",
    ],
    ["Lifetime", "pi-sandbox process"],
    [
      "Timeout cap",
      input.execution.maximumTimeoutMs === undefined
        ? "none"
        : `${input.execution.maximumTimeoutMs / 1_000} seconds`,
    ],
    [
      "Processes",
      input.execution.backend === "bubblewrap"
        ? "independent commands; background descendants remain until sandbox shutdown"
        : "independent commands; background survivors may remain; cleanup only while direct child is active",
    ],
    [
      "Code mode",
      input.codemodeEnabled === true ? "enabled (nested tool policy applies)" : "disabled",
    ],
    ["MCP servers", String(input.mcpServerCount ?? 0)],
    ["Execution", executionDisplay(input.execution)],
    ["Network", networkDisplay(input.network, input.execution)],
    ["Config", input.configPath],
    ["Models", input.modelsFile],
    ["Extensions", input.extensions.length === 0 ? "none" : input.extensions.join(", ")],
    [
      "Identity",
      input.identity.mode === "disabled" ? "disabled" : `broker via ${IDENTITY_BROKER_SOCKET_PATH}`,
    ],
    ["User state", input.userStateDir],
  ];
  return `${input.initialized ? "Pi Sandbox: initialized" : "Pi Sandbox: unavailable"}\n\n${formatKeyValues(rows)}\n\nUse /sandbox mounts or /sandbox policy for details.`;
}

export function formatSandboxMounts(
  cwd: string,
  execution: ExecutionConfig,
  filesystem: SandboxConfig["filesystem"],
): string {
  if (execution.backend === "direct") {
    return "Execution mounts\n\nDirect execution uses the ordinary host filesystem as the current user.\nThere is no mount namespace or filesystem containment boundary.";
  }
  if (execution.backend === "seatbelt") {
    return `Seatbelt filesystem policy\n\nHost paths retain their absolute names. The launch directory is ${filesystem.cwdWritable ? "writable" : "read-only"}; other ordinary host paths are read-only except denied directories.\nDenied directories: ${safeDisplay(filesystem.deniedPaths.join(", ") || "none")}. Denied paths remain host entries; they are not empty mount masks. A denied ancestor admits only CWD, then explicit interior denials apply.\nHOME and TMPDIR use a real host scratch directory owned by this executor. There is no private /tmp or mount namespace. Scratch cleanup is best effort. Normal foreground exit can leave background descendants alive. Failure/cancellation/close attempts process-group cleanup only while the direct child is active; survivors retain original grants, including after owner death.`;
  }
  const mounts = describeBubblewrapMounts(cwd, filesystem.cwdWritable, filesystem.hiddenPaths);
  const table = formatTable(
    ["TARGET", "ACCESS", "CONTENT"],
    mounts.map((mount) => [mount.target, mount.access, mount.content]),
  );
  return `Sandbox mounts (configured policy)\n\n${table}\n\nHOME: ${safeSandboxEnvironment().HOME}\n${filesystem.cwdWritable ? "Only the launch directory persists writes to the host." : "The launch directory is read-only. Only private temporary/runtime storage is writable."}`;
}

export function formatSandboxPolicy(
  input: PolicyDiagnosticInput,
  subject?: SandboxDiagnosticSubject,
): string {
  if (subject !== undefined) return formatSubjectPolicy(input, subject);
  const rows = diagnosticSubjects(input.config).flatMap((candidate) => {
    const policy = getSubjectPolicy(input.config, candidate);
    const boundary = executionBoundary(input, candidate);
    return [
      [
        candidate,
        boundary,
        policy.mode,
        policy.sessionGrant,
        activeGrantDisplay(
          policy,
          candidate === "user_shell" ? false : input.hasSessionGrant(candidate),
        ),
      ],
      ...commandClassPolicies(policy).map(([commandClass, classPolicy]) => [
        `${candidate} (${commandClassLabel(commandClass)})`,
        boundary,
        classPolicy.mode,
        classPolicy.sessionGrant,
        activeGrantDisplay(classPolicy, input.hasSessionGrant(candidate, commandClass)),
      ]),
    ];
  });
  return `Effective policy\n\n${formatTable(
    ["SUBJECT", "EXECUTION", "MODE", "SESSION OPTION", "ACTIVE GRANT"],
    rows,
  )}\n\nNetwork: ${networkDisplay(input.config.network, input.config.execution)}.\nDisabled tools are not advertised to the model.`;
}

export function diagnosticSubjects(config: SandboxConfig): readonly string[] {
  return Object.freeze([...Object.keys(config.tools), "user_shell"]);
}

export function sandboxCommandArguments(config?: SandboxConfig): readonly string[] {
  return Object.freeze([
    "mounts",
    "policy",
    ...(config === undefined
      ? []
      : diagnosticSubjects(config).map((subject) => `policy ${subject}`)),
  ]);
}

function formatSubjectPolicy(
  input: PolicyDiagnosticInput,
  subject: SandboxDiagnosticSubject,
): string {
  const policy = getSubjectPolicy(input.config, subject);
  const granted = subject === "user_shell" ? false : input.hasSessionGrant(subject);
  const advertised =
    subject === "user_shell" ? "not a model tool" : input.isToolActive(subject) ? "yes" : "no";
  const rows: Array<readonly [string, string]> = [
    ["Execution", executionBoundary(input, subject)],
    ["Mode", policy.mode],
    ["Advertised", advertised],
    ["Approval", approvalDisplay(policy, granted)],
    ["Session option", policy.sessionGrant],
    ["Active grant", activeGrantDisplay(policy, granted)],
  ];
  const classSections: string[] = [];
  if (subject === COMMAND_CLASS_TOOL) {
    const sets = Object.entries(policy.commandSets ?? {});
    if (sets.length > 0) {
      rows.push(["Configured command sets", String(sets.length)]);
      classSections.push(
        "Administrator command sets (allow exceptions, not built-in read-only proofs):\n" +
          sets
            .map(
              ([id, set]) =>
                `  ${id}: ${set.commands.map((command) => JSON.stringify(command)).join(", ")}; required flags: ${set.requiredFlags.join(", ") || "none"}; optional flags: ${set.optionalFlags.join(", ") || "none"}; options: ${JSON.stringify(set.options)}; operands: ${set.operands.min}..${set.operands.max}`,
            )
            .join("\n"),
      );
    }
    for (const [commandClass, classPolicy] of commandClassPolicies(policy)) {
      const label = capitalize(commandClassLabel(commandClass));
      const classGranted = input.hasSessionGrant(subject, commandClass);
      rows.push(
        [label, classPolicy.mode],
        ["  Approval", approvalDisplay(classPolicy, classGranted)],
        ["  Session option", classPolicy.sessionGrant],
        ["  Active grant", activeGrantDisplay(classPolicy, classGranted)],
      );
      classSections.push(commandClassSection(label, input.commandAnalyzer));
    }
  }
  const scope = [
    ...subjectScope(input, subject),
    ...(classSections.length === 0
      ? []
      : [
          "Command classification selects only the approval policy; an approved command runs unchanged within the same boundary.",
        ]),
  ];
  return `Policy: ${subject}\n\n${formatKeyValues(rows)}${classSections
    .map((section) => `\n\n${section}`)
    .join("")}\n\nScope:\n${scope.map((line) => `  ${line}`).join("\n")}`;
}

function commandClassPolicies(
  policy: SubjectPolicy,
): readonly (readonly [(typeof COMMAND_CLASSES)[number], CommandClassPolicy])[] {
  return COMMAND_CLASSES.flatMap((commandClass) => {
    const classPolicy = policy.commandClasses?.[commandClass];
    return classPolicy === undefined ? [] : [[commandClass, classPolicy] as const];
  });
}

function commandClassSection(
  label: string,
  analyzer: PolicyDiagnosticInput["commandAnalyzer"],
): string {
  if (analyzer === undefined) return `${label} commands:\n  registry unavailable`;
  const names = (kind: "shell_builtin" | "executable") =>
    analyzer.commands
      .filter((command) => command.kind === kind)
      .map((command) => safeDisplay(command.name))
      .join(", ") || "none";
  return `${label} commands (registry version ${analyzer.version}):\n  Shell builtins: ${names("shell_builtin")}\n  Executables: ${names("executable")}`;
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function executionBoundary(input: PolicyDiagnosticInput, subject: string): string {
  if (input.hostToolScopes?.[subject] !== undefined) return "host";
  return input.config.execution.backend === "bubblewrap"
    ? "sandbox"
    : input.config.execution.backend;
}

function subjectScope(input: PolicyDiagnosticInput, subject: string): readonly string[] {
  const hostScope = input.hostToolScopes?.[subject];
  if (hostScope !== undefined) {
    return [
      `Runs the compiled managed extension operation ${hostScope} directly on the host as the current user.`,
      "Uses the user's host filesystem, environment, credentials, and network access.",
      "Is not restricted by the selected sandbox boundary, its filesystem setting, or its network setting.",
    ];
  }
  if (input.config.execution.backend === "direct") {
    return [
      ...directSubjectScope(subject),
      networkScope(input.config.network, input.config.execution),
    ];
  }
  if (input.config.execution.backend === "seatbelt") {
    return [
      "Runs under macOS Seatbelt filesystem and network policy at ordinary host paths.",
      input.config.filesystem.cwdWritable
        ? "May write inside the launch directory and its real host scratch directory."
        : "The launch directory is read-only; only its real host scratch directory permits ordinary file writes.",
      "Effective denied subtrees cannot be read or written. A denied ancestor admits only CWD, with explicit interior denials preserved; directory names are not masked.",
      "Commands complete independently and may overlap. Background descendants can survive normal completion; cancellation/failure/close attempts group cleanup only while the direct child is active. Survivors may outlive owner death with their original grants.",
      networkScope(input.config.network, input.config.execution),
    ];
  }
  return [
    ...sandboxSubjectScope(subject, input.config.filesystem.cwdWritable),
    ...(input.config.filesystem.hiddenPaths.length > 0
      ? [
          "Configured hidden files and directories are masked when present at startup, including inside the launch directory. Missing paths are skipped.",
        ]
      : []),
    networkScope(input.config.network, input.config.execution),
  ];
}

function sandboxSubjectScope(subject: string, cwdWritable: boolean): readonly string[] {
  if (!cwdWritable && ["write", "edit", "bash", "user_shell"].includes(subject)) {
    return [
      ...(subject === "bash" || subject === "user_shell"
        ? [SANDBOX_SUBJECT_SCOPES[subject]![0]!]
        : []),
      "The host filesystem, including the launch directory, is read-only.",
      "May write private /tmp and /run state that disappears when pi-sandbox exits.",
    ];
  }
  return SANDBOX_SUBJECT_SCOPES[subject] ?? ["Runs inside the Pi Sandbox boundary."];
}

function directSubjectScope(subject: string): readonly string[] {
  if (subject === "bash") {
    return [
      "Runs model-requested Bash directly on the host as the current user after policy approval.",
      "Has the user's ordinary host filesystem and process authority; structured tool policies do not restrict it.",
    ];
  }
  if (subject === "user_shell") {
    return [
      "Runs user-invoked ! shell commands directly on the host as the current user.",
      "Has the user's ordinary host filesystem and process authority; it is not a model tool.",
    ];
  }
  return [
    "Runs the typed operation directly on the host as the current user.",
    "Has no filesystem containment boundary beyond the operation's typed arguments and the user's OS permissions.",
  ];
}

function executionDisplay(execution: ExecutionConfig): string {
  if (execution.backend === "seatbelt") return "macOS Seatbelt policy (shared host namespaces)";
  return execution.backend === "bubblewrap"
    ? "Bubblewrap sandbox"
    : "direct host execution (uncontained)";
}

function networkDisplay(network: NetworkConfig, execution: ExecutionConfig): string {
  if (execution.backend === "seatbelt")
    return network.mode === "none"
      ? "disabled by Seatbelt policy (shared host namespace)"
      : "host (unrestricted by network policy)";
  if (network.mode === "local") return "local (sandbox loopback only)";
  return network.mode === "none" ? "disabled (private namespace)" : "host (unrestricted)";
}

function networkScope(network: NetworkConfig, execution: ExecutionConfig): string {
  if (execution.backend === "seatbelt")
    return network.mode === "none"
      ? "Seatbelt denies network access; it does not create a private network namespace."
      : "Uses host networking, including host loopback, subject to other Seatbelt restrictions.";
  if (network.mode === "local")
    return "Can access only sandbox-local TCP/UDP services; host networking and named Unix sockets are unavailable.";
  return network.mode === "none"
    ? "Has no network access."
    : "Can access host loopback, LAN, and Internet services through the host network namespace.";
}

function getSubjectPolicy(config: SandboxConfig, subject: SandboxDiagnosticSubject): SubjectPolicy {
  if (subject === "user_shell") return { mode: "allow", sessionGrant: "never" };
  const policy = config.tools[subject];
  if (policy === undefined) throw new Error(`Unknown diagnostic policy subject: ${subject}`);
  return policy;
}

function activeGrantDisplay(policy: Pick<SubjectPolicy, "mode">, granted: boolean): string {
  return policy.mode === "ask" ? (granted ? "yes" : "no") : "-";
}

function approvalDisplay(policy: Pick<SubjectPolicy, "mode">, granted: boolean): string {
  switch (policy.mode) {
    case "allow":
      return "not required";
    case "ask":
      return granted ? "session grant active" : "required";
    case "deny":
      return "always denied";
    case "disabled":
      return "disabled";
  }
}

function formatKeyValues(rows: readonly (readonly [string, string])[]): string {
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows
    .map(([label, value]) => `${`${label}:`.padEnd(width + 2)} ${safeDisplay(value)}`)
    .join("\n");
}

function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
  const safeRows = rows.map((row) => row.map((value) => safeDisplay(value)));
  const widths = headers.map((header, index) =>
    Math.max(header.length, ...safeRows.map((row) => row[index]?.length ?? 0)),
  );
  return [headers, ...safeRows]
    .map((row) =>
      row
        .map((value, index) =>
          index === row.length - 1 ? value : value.padEnd((widths[index] ?? value.length) + 2),
        )
        .join(""),
    )
    .join("\n");
}

function safeDisplay(value: string): string {
  return [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const unsafe =
        codePoint <= 0x1f ||
        (codePoint >= 0x7f && codePoint <= 0x9f) ||
        codePoint === 0x2028 ||
        codePoint === 0x2029;
      return unsafe ? `\\u${codePoint.toString(16).padStart(4, "0")}` : character;
    })
    .join("");
}
