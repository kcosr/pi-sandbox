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
  readonly hasSessionGrant: (subject: ApprovalSubject) => boolean;
  readonly isToolActive: (subject: ToolName) => boolean;
  readonly hostToolScopes?: Readonly<Record<string, string>>;
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
      "CWD access",
      input.execution.backend === "direct"
        ? "host permissions (uncontained)"
        : input.filesystem.cwdWritable
          ? "read/write"
          : "read-only",
    ],
    ["Lifetime", "pi-sandbox process"],
    [
      "Processes",
      input.execution.processLifetime === "sandbox"
        ? "persist until sandbox shutdown or operation failure"
        : "cleaned up after each command",
    ],
    [
      "Code mode",
      input.codemodeEnabled === true ? "enabled (nested tool policy applies)" : "disabled",
    ],
    ["MCP servers", String(input.mcpServerCount ?? 0)],
    ["Execution", executionDisplay(input.execution)],
    ["Network", networkDisplay(input.network)],
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
  const rows = diagnosticSubjects(input.config).map((candidate) => {
    const policy = getSubjectPolicy(input.config, candidate);
    return [
      candidate,
      executionBoundary(input, candidate),
      policy.mode,
      policy.sessionGrant,
      activeGrantDisplay(
        policy,
        candidate === "user_shell" ? false : input.hasSessionGrant(candidate),
      ),
    ];
  });
  return `Effective policy\n\n${formatTable(
    ["SUBJECT", "EXECUTION", "MODE", "SESSION OPTION", "ACTIVE GRANT"],
    rows,
  )}\n\nNetwork: ${networkDisplay(input.config.network)}.\nDisabled tools are not advertised to the model.`;
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
  return `Policy: ${subject}\n\n${formatKeyValues(rows)}\n\nScope:\n${subjectScope(input, subject)
    .map((line) => `  ${line}`)
    .join("\n")}`;
}

function executionBoundary(input: PolicyDiagnosticInput, subject: string): string {
  if (input.hostToolScopes?.[subject] !== undefined) return "host";
  return input.config.execution.backend === "bubblewrap" ? "sandbox" : "direct";
}

function subjectScope(input: PolicyDiagnosticInput, subject: string): readonly string[] {
  const hostScope = input.hostToolScopes?.[subject];
  if (hostScope !== undefined) {
    return [
      `Runs the compiled managed extension operation ${hostScope} directly on the host as the current user.`,
      "Uses the user's host filesystem, environment, credentials, and network access.",
      "Is not restricted by the Bubblewrap boundary, its filesystem setting, or its network setting.",
    ];
  }
  if (input.config.execution.backend === "direct") {
    return [...directSubjectScope(subject), networkScope(input.config.network)];
  }
  return [
    ...sandboxSubjectScope(subject, input.config.filesystem.cwdWritable),
    ...(input.config.filesystem.hiddenPaths.length > 0
      ? [
          "Configured hidden files and directories are masked when present at startup, including inside the launch directory. Missing paths are skipped.",
        ]
      : []),
    networkScope(input.config.network),
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
  return execution.backend === "bubblewrap"
    ? "Bubblewrap sandbox"
    : "direct host execution (uncontained)";
}

function networkDisplay(network: NetworkConfig): string {
  if (network.mode === "local") return "local (sandbox loopback only)";
  return network.mode === "none" ? "disabled (private namespace)" : "host (unrestricted)";
}

function networkScope(network: NetworkConfig): string {
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

function activeGrantDisplay(policy: SubjectPolicy, granted: boolean): string {
  return policy.mode === "ask" ? (granted ? "yes" : "no") : "-";
}

function approvalDisplay(policy: SubjectPolicy, granted: boolean): string {
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
