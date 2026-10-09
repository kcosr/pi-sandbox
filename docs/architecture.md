# Architecture

## Boundary placement

Pi Sandbox deliberately keeps the stock Pi process on the host. Pi owns the
terminal UI, provider credentials, provider traffic, and session state. The
compiled Pi Sandbox extension owns tool presentation, approval, and process
lifecycle. One Bubblewrap worker lives for the `pi-sandbox` process; each
allowed built-in operation runs through the administrator-selected Bubblewrap
or direct backend.

```text
trusted host
  optional root systemd identity broker
    -> SO_PEERCRED UID -> host account/group lookup -> optional users.d + groups.d rules
  prebuilt Bun pi-sandbox executable
    pinned, minimally patched Pi runtime
      forced inline Pi Sandbox extension
        compiled extension registry
        model-tool policy and approval UI
        bounded direct-argv host executor
        selected built-in executor
          -> Bubblewrap process-lifetime worker and framed pipe IPC (Linux)
          -> or bounded direct host child (Linux/macOS)
```

Allowing a tool call never delegates to Pi's stock host implementation. The
extension replaces all seven built-ins and maps the exact approved request to a
fixed direct executable invocation through the selected backend. User `!`
shell commands follow the same route. Administratively selected
managed-extension tools may instead declare host execution. Those tools still use the same policy and
approval machinery, but run only their fixed executable and argument shape as
the invoking user outside Bubblewrap.

## Managed MCP and code mode

The forced extension composes Pi's patched MCP and code-mode factories only from
administrator policy. Code mode executes bounded JavaScript in Pi's QuickJS WASM
worker with tool bridges and session store; it has no Node, filesystem, process,
network or provider-model API. Every nested tool uses the same wrapped execution
and approval path as a direct invocation. Code mode has a feature switch, not an
additional approval subject.

MCP servers use Pi's existing Streamable HTTP and stdio transports on the host.
The main TOML owns endpoints, commands, credential mappings, exposure, and ordered
per-server wildcard policies. User/project MCP configuration, extension-registered
servers, OAuth, mutable management, resources and prompts are disabled. HTTP
headers and stdio environment values are explicit projections of a startup
snapshot; stdio does not inherit the complete host environment. Account macros
can personalize endpoint path segments and query values without changing the
configured host.

Each logical session owns its MCP connections and admitted catalog. Whole-catalog
validation precedes publication. Wrappers retain typed original server/tool
identity and a revision; changed catalogs and disconnects revoke pending
approvals and affected grants. Static and dynamic subjects share one policy
engine, prompt mutex and grant store. Hidden/withdrawn tool references cannot
execute. User tool selections also apply to late registrations.

Code mode and MCP have bounded source, output, catalog, concurrency and duration
limits. Tool calls are never automatically replayed after transport failures.
Shutdown closes admission, cancels scripts and calls, reaps owned stdio process
groups, and awaits local cleanup before ending audit identity. The process-owned
Bubblewrap worker remains available for the next logical session. Results stay
inline; no host temporary output files are presented as sandbox-readable paths.

## RPC and session lifecycle

The same managed executable accepts Pi's `--mode rpc`. A supervisor selects its
workspace using the operating-system CWD when spawning the process; Sandbox
adds no CWD flag or RPC parameter. The canonical launch path, effective policy,
and executor remain fixed for that process. Pi session creation, resume,
fork/clone, import, and reload must retain exactly that canonical CWD. A different
workspace requires a new process. Alternate spellings and symlink aliases are
rejected even when they resolve to the same directory, because Pi also discovers
ancestor instructions using the supplied path.

The generic Pi workspace admission hook runs before a target's settings or
resources are loaded and, for replacement, before the healthy outgoing runtime
is invalidated. Each replacement binds the new extension runtime exactly once.
Shutdown clears outgoing approval grants and ends its audit session; the new
runtime starts with fresh grants and audit identity while retaining the same
process-owned executor. An accidental duplicate start disables that extension
runtime's tool and shell access instead of reinitializing policy.

An exact `--version` request reports the pinned Pi version without loading policy,
probing an executor, or selecting a workspace. Argument and root-user validation
still run. This lets supervisors probe the executable from their own directory
before spawning an actual worker in its requested workspace.

## Session maintenance

The main TOML's required `[sessions].retention_days` controls host-side Pi
conversation retention. The private entry point supplies the generic awaited
Pi `beforeRun` hook introduced by patch `0004-session-startup-maintenance`.
After session selection and metadata-only exits, this hook receives the
resolved interface mode, session manager, and optional effective custom session
directory. It finishes before stdin consumption, theme initialization, or any
TUI, print, JSON, or RPC runner starts. Retention policy remains in Pi Sandbox,
outside the upstream hook.

With retention enabled, startup touches the selected session's modification
time, excludes it from deletion, and checks a small per-storage-root attempt
record under the agent directory. A due sweep streams one level of workspace
directories for default storage or one flat custom directory. It checks file
metadata in bounded concurrent batches and reads only a bounded header for expired regular JSONL candidates;
it never parses transcript bodies. The sweep is awaited and normally runs once
per 24 hours, with a delayed progress message only for interactive mode. A
retention-policy change makes it due immediately. Recording the attempt before
scanning limits repeated startup work after an error or interruption.

Logical session activation also refreshes modification time through the forced
extension's session-start callback. All maintenance failures are nonfatal and
silent. Duplicate concurrent sweeps are tolerated without locks or a process
registry. Disabling retention skips both sweeping and timestamp updates. This
maintenance is independent of host-managed audit-log retention.

## Managed application and identity broker

The installed application is one prebuilt Bun executable. Its private entry
point rejects an effective root UID before Pi starts, captures the canonical
launch CWD, validates administrative configuration, probes the selected
executor, filters caller arguments, and calls Pi's `main()` API. The Pi Sandbox
extension and a build-selected set of managed extension modules are compiled
into the same executable. Pi still receives
exactly one forced inline Pi Sandbox extension factory; managed modules
register through Pi Sandbox's restricted extension API rather than receiving
Pi's extension API directly.

The build-selected distribution manifest lists every extension manifest and
the platform installation layout. Extension source may live in another
repository. Release composition emits static imports, so there is no runtime
module path, discovery, dynamic import, or package installation. The default
public distribution selects Git; another distribution can select any desired
combination.
The compiled catalog validates extension API versions, identifiers, semantic
versions, tool schemas, and collisions before administrative configuration is
admitted. The root configuration selects a subset of that immutable catalog.

The private entry point always disables extension discovery, Pi's built-in
extension factories, and Pi's built-in tools. It rejects arguments and commands
that could load executable extension code, manage packages, or restore stock
tool implementations. Skills and user tool-selection options remain available:
they may provide instructions or narrow the visible catalog, but all executable
tool authority still comes from the forced extension.

Configuration begins at the distribution's compiled `config_dir/config.toml`.
Version-3 distribution manifests explicitly select `allow_config_override`;
when true, a leading `--config FILE` selects a different TOML for this process.
The flag is consumed before Pi argument handling, and invalid selected input
fails closed. Managed builds set the switch to false and reject the flag.
When configured, the Bun process asks the
separate static Rust broker for the caller's combined user/group rules. The broker uses kernel
peer credentials, resolves account and primary/supplementary membership through
the host NSS resolver, and reads protected root-owned rules. It accepts one
newline-delimited request without requiring a client half-close. Matching
explicit permissions combine using least restrictive wins; conflicting backend,
model, or scoped environment values fail. It returns the environment and optional model,
execution, network, filesystem, and atomic tool-policy patch. If no rules match, the broker
returns an empty patch. The Bun process validates the response independently,
overlays it on the global policy and scoped environment from the main TOML, constructs one effective
configuration, and loads only its selected model catalog. Pi-scoped values are
applied to the trusted host Pi process, sandbox-scoped values are added to the
cleared Bubblewrap environment or overlaid on the inherited direct-command
environment, and extension-scoped values are admitted only
for their named extension. The patched Pi runtime omits its internal model
catalog. `PI_CODING_AGENT_DIR` still selects user credentials, sessions,
settings, skills, themes, and logs, but cannot redirect administrative policy,
broker selection, or models. Missing or invalid effective inputs abort startup.

Before applying the effective environment or starting executors, operational
startup expands bare `~`, leading `~/`, and account macros in configured scoped
environment values and hidden paths using the invoking effective OS account.
Expansion follows the broker merge and is independent of `$HOME` and CWD.
Expanded values retain the existing environment bounds and filesystem checks.
Installation validation checks syntax without expanding the installer's home.

The distribution manifest fixes the config directory, libexec directory,
launcher path, identity and event-collector sockets, Linux systemd unit directory, and Linux
Bubblewrap provider at build time. A system provider names an unmanaged
absolute executable. A bundled provider supplies a verified native binary that
is installed under the root-owned libexec directory and selected by the
compiled runtime. macOS packages only the application; the Linux-only broker is not
included. Keeping the product executable behind its configured launcher path provides a canonical command,
but does not constitute access control against the logged-in user.

The root check has no configuration override. Only the non-interactive
`--validate-installation` and `--print-execution-backend` commands used by the
system installers are admitted with effective UID `0`; they validate
administrative inputs and never start Pi or an execution backend.

## Tool catalog and approvals

The extension registers only configured, non-disabled model tools. The exact
catalog is the seven replacement tools plus every tool contributed by selected
compiled extensions. Immediately before execution it creates a stable snapshot
of the final tool input, obtains the configured policy decision, and maps that
same snapshot to either a sandbox request or the managed extension's fixed host
request.

Approval presentation and execution authority are separate:

- policy decides whether a request may run;
- the selected execution boundary decides what an allowed request can reach.

An approval cannot add a mount, change the operation being executed, or switch
a tool between configured execution backends. It cannot alter the admitted scoped
environment or enable networking. Host tools intentionally retain the invoking
user's host authority subject to their compiled environment policy as described
below. Prompt errors, loss of interactive UI, and cancellation deny the
request.

## Managed host tools

Managed host tools exist for small, explicitly compiled operations that need
the invoking user's ordinary host identity. They run with the captured launch
CWD and a separately constructed environment for each selected extension.
Most of the ordinary ambient host environment remains available. An extension
declares the managed variable names it accepts, the exact inherited names or
prefixes it removes, and any fixed values it applies. Broker values under
`environment.extensions.<id>` can populate only names declared by that
extension. Pi-scoped values and variables declared by other extensions are
removed, so one extension does not receive another extension's managed
identity. The central host executor uses an absolute executable, direct
argument vector, bounded standard input, duration, and output; it never invokes
a shell. Cancellation, timeout, output overflow, shutdown, or process-start
failure terminates the command process group and fails the operation. Host
tools are outside Bubblewrap and therefore outside its mount, seccomp, and
network policy.

Managed-extension API version 3 lets each tool provide a short call summary.
The central Pi Sandbox adapter validates and bounds that plain-text summary and
renders it inside Pi's normal tool card; extensions do not receive Pi's TUI or
theme APIs. A formatter must select only the identifying fields that are useful
before approval and omit payloads or credentials.

The Git managed extension exposes only `git_clone({ repository })`. It validates
the administrator's exact host and scheme allowlists, derives one immediate
child name beneath the launch CWD from the repository basename, and executes:

```text
/usr/bin/git clone -- <repository> <derived-absolute-child>
```

The model cannot select a target directory or Git options. After cloning,
ordinary Git remains available to Bash. In Bubblewrap mode the host root is
read-only and CWD access follows `filesystem.cwd_writable`; in direct mode Git
has the current user's ordinary host authority. Bash can run repository-local
commands through the selected backend, but commands that require host writes
fail when the CWD is read-only. The managed `git_clone` tool itself remains a
host operation and is unaffected by Bubblewrap filesystem settings.
The normal tool card shows the submitted repository locator.

The Git host and scheme allowlists validate only the submitted repository
locator. The compiled Git environment neutralizes Git URL-rewrite and prompt
configuration, but SSH configuration, DNS, proxies, and redirects may still
affect the contacted destination. The locator allowlist is not egress
filtering.

Two extension kinds are supported. A `managed` extension uses Pi Sandbox's
small host-command API and gets its declared scoped environment, executable
checks, bounded process lifecycle, and optional call-summary renderer. A
`pi-tool` extension is an ordinary Pi extension factory restricted at startup
to `registerTool` and `exec`; its declared tool names must exactly match its
registrations. Pi Sandbox wraps those tools with the same allow/ask/deny/
disabled policy. Standard Pi tool extensions are trusted compiled code and may
exercise host authority internally, so they do not receive the containment
guarantees of the managed API merely by being policy-wrapped.

User `!` shell bypasses model-tool approval because the user invoked it
directly. It uses the selected built-in executor and is never advertised to the
model. Direct mode is configured up front; it is not a fallback.

## Direct executor

Direct mode runs each approved built-in request as a bounded, detached process
group in the captured launch CWD. It preserves the ordinary user environment,
overlays the effective `environment.sandbox` values, and resolves `~` against
the user's real home. The same direct-argument validation, input/output limits,
timeouts, cancellation, and descendant cleanup used for managed host commands
apply. There is no mount, PID, network, seccomp, or filesystem containment.

Linux uses the distribution's fixed GNU utility paths. macOS direct mode
resolves a declared Homebrew GNU command profile (coreutils, findutils, grep,
and gawk) plus system Bash, `sh`, and `file`, and fails startup if any command is
missing. This preserves one typed-tool implementation instead of silently
changing semantics between GNU and BSD utilities.

## Bubblewrap worker

The host starts one hidden worker mode of the same compiled executable inside
the build-selected system or bundled Bubblewrap executable. That boundary has private user, PID, IPC, UTS, and cgroup namespaces;
the effective policy selects a private or shared-host network namespace. It also
has dropped capabilities, a new session, and parent-death semantics.
Its inherited environment is cleared before a small fixed environment is
constructed and the effective configured `sandbox` scope is added. Those values are
deliberately visible to the model and cannot replace fixed sandbox values such
as `HOME`, `PATH`, or `TMPDIR`.

The host and worker communicate over the worker's anonymous stdin/stdout pipes
using length-prefixed, versioned JSON frames. There is no socket, listening
port, or filesystem control endpoint. Requests carry an identifier, direct
argument vector, bounded input, duration, and output ceiling. The worker
serializes requests and returns framed output and results.

The mount view is:

```text
/                              host root, read-only at identical paths
<captured launch CWD>          explicit same-path bind, read/write or read-only
/tmp                           private writable temporary filesystem by default
private runtime directory     private writable runtime filesystem
/proc                          sandbox process namespace
/dev                           minimal sandbox devices
```

Host `/proc`, `/sys`, `/dev`, `/run`, privileged sockets, desktop buses, agent
sockets, and container-engine sockets are not made available as host resources.
System executables and libraries needed by sandbox commands remain visible
through the read-only host-root view.

The exact-path mount contract means a launch from
`/home/alice/worktrees/example` also starts every sandbox operation in
`/home/alice/worktrees/example`. Absolute paths do not need translation.

## Bubblewrap filesystem authority

With `filesystem.cwd_writable = true` (the packaged default), the captured
launch CWD subtree is the maximum persistent host mutation authority for
Bubblewrap operations. With `false`, the CWD remains readable but cannot be
modified through the sandbox. In both cases the broader ordinary host tree is
readable and read-only except for the main configuration's `hidden_paths`.

Both modes create an explicit same-path CWD bind after the private mounts:
`--bind` for writable access, `--ro-bind` for read-only access. Private `/tmp`
and runtime directories persist across tool calls and logical Pi sessions in
the same process, then disappear when `pi-sandbox` exits. A CWD beneath `/tmp`
remains visible through its explicit bind while the rest of `/tmp` stays private.
When CWD is exactly `/tmp`, only writable access is supported; that explicit host
bind masks the private `/tmp` mount. Read-only CWD exactly `/tmp` is rejected.
CWD `/` and overlaps with `/proc`, `/sys`, `/dev`, or `/run` remain rejected.

Hidden directories are private tmpfs masks; hidden regular files use
`--ro-bind-data` with a distinct inherited read-only EOF descriptor for each
effective file mask. The host opens `/dev/null` once, duplicates that input into
the child's descriptor slots, and closes its descriptor immediately after
spawning. Bubblewrap consumes those inputs during startup and creates private
empty file masks without persistent host placeholders. Startup silently skips
missing targets and requires existing targets to be canonical directories or
regular files. Symlink components, including dangling links and ancestors of
missing targets, permission errors, non-directory ancestors, and special files
fail startup. Skipped paths created later on the host may remain visible until
restart unless another mask covers them. Mount planning
applies outer masks before restoring CWD and interior masks afterward. Nested
redundant entries are reduced separately in these groups; the final directory masks are
remounted read-only without recursively changing CWD permissions, while file
mask data is read-only from creation. This retains
ordinary host utility access while removing siblings beneath a hidden runs
parent. Exact CWD, `/`, `/tmp`, and private-system overlaps are rejected. The
policy is immutable for the process and is not supplied by user/group overrides.

Structured tools validate their inputs and report errors coherently, but the
mount namespace enforces filesystem permissions. An approved Bash command can
write private temporary state even when the CWD is read-only. Tool approval
cannot broaden filesystem access. Direct mode requires `cwd_writable = true`
and empty `hidden_paths`
and does not provide a filesystem ceiling. Managed host tools retain their
separate host authority.

## Network authority

For Bubblewrap tools, the required administrative mode is `none` or `host`. `none`
creates a private network namespace and denies `socket`. `host` shares the
complete host network namespace and permits socket creation, including host
loopback, LAN, Internet, and reachable Unix-domain services. Bubblewrap does not
provide destination filtering, and Pi Sandbox exposes no filtered network mode.
Provider networking continues independently in the trusted host-side Pi
process. Managed host tools and direct built-in execution use the invoking
user's complete host network authority. Direct mode therefore requires the
explicit `host` value.

A classic seccomp BPF filter always denies the `io_uring` control syscalls,
`link`, and `linkat`; offline mode additionally denies `socket`. Anonymous
`socketpair()` remains available because Bun uses it when spawning a child. The
executor streams the compiled filter to Bubblewrap on a dedicated inherited
file descriptor and rejects unsupported architectures before execution.

## Execution and lifecycle

Structured tools use fixed absolute executables with explicit argument arrays;
no host shell is implied. Input, output, arguments, and duration are bounded.
Malformed inputs, process startup failure, excessive output, timeout, and
cancellation fail closed. Bash is the only operation that deliberately invokes a
shell, and its complete approved command is passed as one argument.

On cancellation or timeout, the selected executor terminates the command process group,
escalates after a bounded grace period, and kills every remaining command
process visible in its private PID namespace before starting another request.
This prevents background descendants from becoming persistent even though the
mount namespace remains alive. Closing the executor terminates active work and,
in Bubblewrap mode, the worker and complete Bubblewrap process tree.

There is never a direct-host fallback. Direct built-in execution occurs only
when `execution.backend = "direct"` was admitted at startup. Managed host
execution occurs only for a tool whose compiled definition selects it. Neither
is a recovery path for a Bubblewrap failure.

## Model-tool event collection

On Linux, the application can connect to a separate root-controlled Unix socket
collector. It records selected model-tool decisions and execution lifecycle
metadata, including target paths and bounded Bash commands, while excluding
file contents and tool output. Human shell commands do not use this path.

The static Rust collector obtains the peer UID and PID from Linux socket
credentials, resolves the account name through the trusted host account system
once per connection, and assigns a connection identifier. Every record includes
`principal_uid`, `principal_user` (null if no account exists), and `principal_pid`;
records do not include a principal GID or group membership. The client includes its Pi
session ID and invocation ID for correlation. The collector submits one-line
structured records to local syslog and acknowledges successful submission.
Server logging infrastructure owns persistence, rotation, retention, and
forwarding. This service is independent of user/group configuration resolution;
it is not an execution backend and does not run tool operations.
