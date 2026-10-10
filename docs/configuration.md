# Configuration and approvals

## Configuration ownership

Pi Sandbox reads the `config_dir/config.toml` path compiled from the
distribution manifest by default. Version 3 of that manifest requires an explicit
`allow_config_override` boolean. The default distribution sets it to `false`
and rejects `--config`. No environment variable, user setting, or project file
can enable this capability.

A distribution built with `allow_config_override = true` accepts a leading
`--config FILE` (or `--config=FILE`) before all Pi arguments. Relative paths
resolve against the launch directory. The option is consumed by Pi Sandbox;
it is never passed to Pi. A missing, repeated, or misplaced option is an error.
An unreadable or invalid selected file fails startup without falling back to
the compiled default. With no option, the compiled default remains selected.

```sh
pi-sandbox --config ./lab/config.toml --model local/example
pi-sandbox --config ./lab/config.toml --validate-installation
```

The selected TOML contains a required absolute `models_file` path. Relative
model paths are not resolved against the TOML directory. Pi Sandbox loads this
file as the complete model catalog and disables Pi's internal model catalog.
`/sandbox` reports the selected TOML and effective models path.

Enabling the CLI option lets the invoking user choose policy, including tool
permissions and the execution backend. Use this build mode for development,
evaluation, or other caller-controlled configurations. Forced extension loading,
compiled tools, the root runtime check, and build-selected sandbox
executables still apply. Identity broker and audit service sockets and their
configuration remain independently installed; `--config` does not relocate
service configuration or user/group drop-in directories.

The main configuration contains the global `pi`, `sandbox`, and
extension-specific scoped environment. The required `identity` table either
disables user resolution or selects the fixed administrator broker. Broker mode
may overlay a combined patch from `config_dir/users.d/*.toml` and
`config_dir/groups.d/*.toml` for the caller and its primary/supplementary groups, including scoped environment, selected model file, execution
backend, process lifetime, network mode, CWD write access, and any subset of model-tool policies. If no rules match,
the main configuration remains unchanged. See
[user and group environment and overrides](identity-broker.md).

The required `execution` table selects `bubblewrap`, `direct`, or `smolvm`. Bubblewrap is
available only on Linux. Direct execution is available on Linux and macOS and
runs approved built-in operations with the invoking user's ordinary host
filesystem and process authority. It is an explicit operating mode, never a
fallback after a sandbox failure. macOS requires `identity.mode = disabled`.
The optional smolvm backend supports Linux x86-64 and requires a provider selected
at build time. It mounts only the launch directory from the host.

The required `network` table selects `none`, `local`, or `host` for built-in tools and
shell commands. Bubblewrap supports all three. smolvm requires `none`, which
disables host/external access while permitting guest-local loopback. Direct execution requires `host` so a
configuration can never claim an isolation mode that the backend does not
enforce. The Linux packaged default is Bubblewrap plus `none`; the macOS
packaged default is direct plus `host`.

The required `[extensions]` table selects from the extensions compiled
into this release. An empty table selects none. Each selected extension parses
its own strict configuration. Runtime paths, user/project extensions, and
uncompiled extension identifiers are rejected.

Configuration is strict: unsupported versions, missing tool policies, unknown
fields, unknown tools, invalid values, duplicate TOML keys, and missing,
unreadable, or invalid configuration and model files are errors. Startup fails
closed. Deployment is responsible for ownership and permissions; Pi Sandbox
does not perform root-ownership or metadata checks on these files.

In managed builds, project-local files are untrusted content and cannot broaden
the installed policy. Configurable builds load a project policy only when the
caller explicitly selects it with `--config`. The only merge combines administrator-owned user/group rules through the broker. Matching explicit permissions use least restrictive wins before overlaying defaults; user rules have no special precedence.

`PI_CODING_AGENT_DIR` remains supported for user state such as credentials,
sessions, settings, skills, themes, and logs. It never changes the administrative
configuration path or `models_file`.

Provider definitions and API-key resolution are documented separately in
[Models and authentication](models.md).

### Home-directory and account expansion

Schema 11 expands bare `~` and a leading `~/` in `filesystem.hidden_paths`,
every configured value under `environment.pi`, `environment.sandbox`, and
`environment.extensions.<id>`, and MCP stdio `env` values. These fields also
accept `{{username}}` and `{{uid}}` anywhere in a string. For example,
`/srv/accounts/{{username}}` becomes `/srv/accounts/alice`, and `~/cache/{{uid}}`
becomes `/home/alice/cache/1001` for that account.
`smolvm.state_directory` also accepts account macros within its absolute path;
it does not accept home-relative paths.

Expansion happens once at operational startup, after broker rules are merged,
using the invoking effective user's canonical OS account name, numeric UID,
and home. It ignores `$HOME`, `$USER`, `$LOGNAME`, `SUDO_USER`, and CWD. The lookup
uses `/usr/bin/getent` on Linux or `/usr/bin/dscacheutil` on macOS, with a cleared
environment, bounded output, and a five-second deadline. Missing account identity
fails operational resolution when needed.

Replacement text is not expanded recursively. Write `{{{{` and `}}}}` for literal
double braces; unknown or malformed macro syntax is an error. Embedded tildes,
`~otheruser`, `$VARIABLE`, globs, and shell expressions remain literal. Recheck
reserved names, normalized paths, extension admission, uniqueness, and size limits
after expansion. Ambient inherited values, compiled fixed extension values, and
values obtained through MCP `*_from_env` mappings are not templated.

HTTP MCP URLs are literal, including ordinary query parameters and percent
escapes. They do not support macro interpolation. Raw braces, dot segments,
userinfo, and fragments are rejected; encoded braces remain literal URL data.

`models_file`, configuration-file locations, build-time installation paths, MCP
URLs, executable paths and argv, literal HTTP headers, and arbitrary extension settings
do not support expansion. Installation validation checks syntax without looking
up the installer's identity, resolving per-user credentials, or requiring hidden
targets to exist. Operational startup validates expanded paths before masking.

## Complete example

```toml
config_version = 11
models_file = "/etc/pi-sandbox/models.json"

[codemode]
enabled = false

[mcp.servers]

[audit]
enabled = false
facility = "local0"

[sessions]
retention_days = 365

[filesystem]
cwd_writable = true
hidden_paths = []

[execution]
backend = "bubblewrap"

[identity]
mode = "disabled"

[network]
mode = "none"

[environment.pi]

[environment.sandbox]

[environment.extensions]

[extensions.git]
allowed_hosts = ["github.com", "git.example.com"]
allowed_schemes = ["https", "ssh"]

[tools.read]
mode = "allow"
session_grant = "never"
audit = false

[tools.grep]
mode = "allow"
session_grant = "never"
audit = false

[tools.find]
mode = "allow"
session_grant = "never"
audit = false

[tools.ls]
mode = "allow"
session_grant = "never"
audit = false

[tools.write]
mode = "ask"
session_grant = "never"
audit = true

[tools.edit]
mode = "ask"
session_grant = "never"
audit = true

[tools.bash]
mode = "ask"
session_grant = "never"
audit = true

[tools.git_clone]
mode = "ask"
session_grant = "never"
audit = true

```

All seven built-in `[tools.<name>]` sections are required, as is one section for
every tool contributed by every selected extension. No policy may be present
for an unselected extension tool. User `!` shell is not configurable: it always
runs without an approval prompt through the selected backend. It is human-only
and is never advertised to the model. Setting `[tools.bash]` to `disabled`
therefore removes model Bash while preserving the user's `!` command.

These TOML sections define built-in and compiled-extension tool policy. MCP tools
use the separate per-server policy below. A broker user/group rule
may override execution backend, process lifetime and network mode and may atomically
replace individual complete policies, including setting
`git_clone` or another selected extension tool to `deny` or `disabled`. User/group environment values
never select an extension, add a tool, change a policy, or authorize a call.

`models_file` is also required and must name a normalized absolute file path.
The administrator may place catalogs elsewhere. In broker mode a root-managed
user/group rule may replace it; no user environment, CLI argument, Pi setting, or
project file can do so. `--model` may select only a model present in the
effective file.

## Code mode and MCP servers

The required `[codemode]` table has `enabled` and optional `timeout_ms` (default
300000; range 1000–3600000). The packaged default disables it. `enabled = true`
makes the stock `codemode` tool available without activating it by default. Users
can select it with Pi's global/project `defaultTools` settings (for example
`["+codemode"]`) or CLI `--tools`; `--no-tools` and `--exclude-tools` remain hard
limits. Pi's `codemode.mode` setting retains its normal `on`/`only` presentation.
There is no separate code-mode TUI toggle. Selecting code-mode exposure for an MCP
can activate code mode, unless excluded by CLI or the user's `autoEnableCodemode`
preference is false. Administrator disablement prevents registration regardless
of these settings.

Pi 1.1 supports additive CLI selection, for example
`--tools +codemode,-bash`, which keeps the other default tools. Plain `--tools`
lists replace the selection; plain lists and `--exclude-tools` support `*`
patterns, while `+name`/`-name` entries require exact names and cannot be mixed
with plain entries. In Pi Sandbox, a final `-name` also prevents later MCP
autoactivation or nested access to that tool; a later `+name` reverses that
removal. `--no-tools` and `--exclude-tools` always take precedence. Additions
remain limited by the effective TOML, including when selected with `--config`:
they cannot restore disabled tools or bypass `ask`/`deny` policies. An explicit
plain allowlist must include any desired MCP tools. `--no-mcp` prevents all MCP
connections for that launch.

While code mode is active, Pi Sandbox adds prompt guidance to prefer dedicated
file tools and use code mode to coordinate calls or process results. If Bash is
also active, the guidance reserves it for programs, builds, tests, and operations
without a suitable dedicated tool. This is refreshed before each agent run and
preserves user system-prompt replacements and additions.

Code mode exposes a restricted JavaScript runtime whose nested tool calls use the same
policies and approval prompts as ordinary calls. There is no `tools.codemode`
policy or separate outer approval. The overall deadline includes nested approval
waits. Code mode has no general host filesystem, process, network, or environment
API; the configured tools define its external capabilities. Script output and
return values share a 16 MiB byte budget. Each nested reply and store-write journal
has its own 16 MiB limit; processing several bounded replies does not consume the
script-output budget.

The required `[mcp.servers]` table is empty by default. Only this main policy can
configure servers; user/project MCP files cannot supply connections or permissions,
and the MCP management CLI is disabled. Server IDs match `[a-z][a-z0-9_]{0,31}`. Each server
requires `enabled`, `transport`, `exposure`, and complete `default_policy`. Optional
`timeout_ms` defaults to 60000 (range 1000–3600000). Disabled servers still validate
structurally but do not resolve credentials, connect, or start a process.

```toml
[mcp.servers.docs]
enabled = true
transport = "http"
url = "https://mcp.example/mcp?workspace=shared"
exposure = "direct"
headers_from_env = { Authorization = "DOCS_AUTHORIZATION" }

[mcp.servers.docs.default_policy]
mode = "ask"
session_grant = "never"
audit = true

[[mcp.servers.docs.tool_rules]]
match = "search_*"
mode = "allow"
session_grant = "never"
audit = false
```

`exposure = "direct"` exposes tools to ordinary calls and code mode;
`exposure = "codemode"` exposes them only through code mode and requires that
feature available. These are administrative presentation defaults. The stock
`/mcp` TUI lists only administrator-enabled, available servers and allows reconnect,
enable/disable, and `direct`, `hidden`, or available `codemode` exposure. It cannot
add servers, edit connections, or sign in. Enabled/exposure choices are remembered
across launches in the user agent directory's `mcp.json`, along with the stock
`autoEnableCodemode` preference. Only these presentation fields are honored;
connection fields, unknown servers, and project MCP files remain inert. Invalid or
oversized user preference files report a sanitized startup error. A saved
code-mode exposure falls back to the administrative default when code mode is
unavailable. Disabling or changing exposure revokes that server's pending approvals
and session grants. Exposure never grants permission. Ordered `tool_rules` match the
server's original tool name, case-sensitively across the whole string. `*` is the
only wildcard; other glob or expression syntax is rejected. The first match wins,
otherwise `default_policy` applies. Each rule supplies all three policy fields.
`disabled` omits a tool; `deny` exposes it but blocks dispatch. An offered session
grant covers exactly one server/tool, never its wildcard rule or an entire server.

HTTP URLs require HTTPS, except HTTP to literal `localhost`, `127.0.0.1`, or
`[::1]`. `headers` supplies literal header values; `headers_from_env` maps each
header name to one effective Pi environment variable. Supply the complete value,
including `Bearer ` for bearer authentication. Transport-controlled headers and
CR/LF are rejected, and literal/referenced destinations must be disjoint without
regard to case. Redirects and browser OAuth are unsupported.

A stdio server instead requires an absolute normalized `command`; optional `args`
is literal argv. `env` supplies explicit values and `env_from_env` maps destination
variable names to effective Pi environment variable names. It runs from the
captured launch CWD with fixed account identity, PATH, locale, and `/tmp` values,
plus these maps, rather than inheriting all Pi credentials. Admin maps may replace
baseline variables, but runtime injection variables remain forbidden. Executable
paths and arguments are literal; deployment must install dependencies. A missing or
nonexecutable stdio command marks only that server `executable-unavailable` for
the process lifetime, without credential projection or a launch attempt. Other
servers and built-in tools remain usable. Restart after fixing the executable.
Structural configuration errors, including invalid command syntax, still abort
startup.

Both MCP transports are host capabilities. Stdio servers are trusted host programs
with the invoking account's authority. Bubblewrap filesystem masks and network
isolation do not restrict MCP servers or their connections. The existing
`environment.pi` scope, including broker account/group overrides, can supply
per-user mapped credentials. The environment snapshot is fixed at process startup;
policy or credential changes require a restart. Missing or invalid resolved
credentials disable only the affected server and produce a sanitized status.

The initial MCP integration exposes tools only. Resources, prompts, server-driven
sampling/elicitation, browser authorization, and user-added servers are unavailable.
Configuration is bounded to 32 servers, 256 ordered rules per server, 64 entries
per map, 16 KiB per resolved value, 64 KiB combined headers/environment per server,
128 command/argv entries and 64 KiB combined, and 256 KiB administrative MCP
configuration. Unknown fields and malformed dormant configurations are errors.

## Launch directory access

Configuration schema 11 requires both keys in `[filesystem]`:

```toml
[filesystem]
cwd_writable = true
hidden_paths = []
```

`true` is the packaged default and permits Bubblewrap operations to write in
the launch directory. `false` keeps the launch directory visible at the same
absolute path but mounts it read-only. This restriction applies to all built-in
tools and human `!` commands, including an allowed model Bash command. Tool
approval never makes a read-only mount writable. Private `/tmp` and `/run`
storage remains writable, so Bash can prepare temporary files without modifying
host directory contents.

Both settings create an explicit same-path CWD bind after the private mounts:
`--bind` for writable access and `--ro-bind` for read-only access. Workspaces
beneath `/tmp` therefore remain visible. CWD exactly `/tmp` is rejected when
`cwd_writable = false`, because that bind would mask private writable `/tmp`.
With `true`, the existing host-`/tmp` CWD behavior is retained. CWD `/` and paths
overlapping `/proc`, `/sys`, `/dev`, or `/run` remain invalid.

Direct execution requires `cwd_writable = true` and `hidden_paths = []`; it cannot enforce a read-only
host CWD. Managed host tools remain outside this restriction and can still
write according to their compiled operation and the invoking user's authority.
`cwd_writable` changes write access only. Use `hidden_paths` to remove selected
host file and directory contents from the sandboxed tools' filesystem view.

A root-managed user/group rule may override this setting with
`[overrides.filesystem] cwd_writable = false`. Omission inherits the parent
value. The final backend/filesystem combination is validated after overrides;
switching a read-only base to direct execution also requires overriding
`cwd_writable` to `true`.

### Hidden files and directories

`hidden_paths` is an explicit array of unique, normalized absolute file or directory
paths, or home-relative paths written as `~` or `~/...`; both accept account macros. The default empty
array preserves the ordinary read-only host view. Missing targets are silently
skipped at worker startup, so shared policies can include optional files such as
`~/.gitconfig`. Existing targets must be canonical directories or regular files.
Symlinks in the entry or any existing ancestor are rejected, including dangling
links and symlink ancestors of missing targets. Permission errors, non-directory
ancestors, and special files also fail startup.
Home-relative paths must also be normalized: `~/.ssh` is valid, while `~/../other`
and `~/.ssh/` are not. Paths must remain unique after expansion. Environment-variable
substitution and globs are not supported.
`/`, `/tmp`, and paths overlapping `/proc`,
`/sys`, `/dev`, or `/run` are rejected. The exact launch CWD cannot be hidden.
Keep the runtime executable and its dependencies outside the effective hidden
view; unavailable runtime resources cause startup or prerequisite checks to fail.

For an evaluation worker launched in `/srv/evaluations/runs/run-a`:

```toml
[filesystem]
cwd_writable = true
hidden_paths = ["/srv/evaluations/runs", "/srv/evaluations/transcripts"]
```

Sandboxed tools see a private read-only mask at the runs parent, with only
`run-a` restored at its identical path. Sibling runs and the shared transcript
directory contents are hidden. An additional file or directory entry inside
`run-a` masks its contents even after the workspace is restored. Redundant nested entries
are reduced deterministically without losing these interior masks. Mask
directories remain visible as empty directories (or the private ancestor
skeleton leading to CWD), and cannot be written or made writable by tools.

Individual files remain visible as empty regular files. For example,
`hidden_paths = ["~/.ssh", "~/.netrc"]` masks the invoking account's `.ssh`
directory and `.netrc` file when present. File masks prevent content changes, unlinking,
and replacement even when the containing CWD is writable. Both mask types are
private to the sandbox and leave the host contents untouched; neither removes
the configured name from directory listings.

Skipped paths are not monitored. If created on the host later, they may be visible
to the running sandbox until restart unless another mask already hides them.

The setting belongs only to the main TOML. User/group `cwd_writable` overrides
preserve it; rules cannot set or clear `hidden_paths`. A rule switching the
backend to direct execution is rejected if hidden paths are configured.

Masks govern tools and human shell commands. Trusted host Pi resource loading,
including ancestor instructions, session files, and managed host extensions,
retains host access. Select these inputs deliberately and hide transcript/log
storage separately when it lives outside the runs directory. Existing hard
links or separate host bind-mount aliases can still expose the same data through
other visible paths. See [security.md](security.md#filesystem-details).

For isolated evaluations, use a harness-controlled `PI_CODING_AGENT_DIR` and
pass task instructions explicitly through RPC. Disable automatic instruction,
skill, prompt-template, and theme discovery with:

```sh
--no-context-files --no-skills --no-prompt-templates --no-themes \
  --system-prompt "" --append-system-prompt ""
```

The empty prompt arguments retain Pi's built-in prompt while suppressing
automatic `SYSTEM.md` and `APPEND_SYSTEM.md` loading, which `--no-context-files`
alone does not disable. Alternatively, supply explicit trusted prompt text or
files outside writable workspaces. Do not add untrusted explicit resource paths.
A tool mount cannot stop host Pi from following a context-file symlink into a
hidden directory.

## Session retention

Schema 9 requires an administrator-owned session policy in the main TOML:

```toml
[sessions]
retention_days = 365
```

`retention_days` must be an integer from `0` through `36500`. The packaged
default is `365`; `0` disables cleanup and last-use timestamp updates.
User/group rules cannot override it. This setting governs Pi conversation
JSONL files, not the system audit log; audit retention remains the host logging
service's responsibility.

Retention uses each session file's modification time, not its creation time or
filesystem access time. Pi advances modification time when it writes session
records. When retention is enabled, Pi Sandbox also refreshes the selected
session on startup and on logical session activation or resume, so reopening an
old conversation keeps it even without another message. The current startup
session is excluded from that process's sweep.

Before starting the TUI or processing a noninteractive prompt, startup checks a
small scheduling record. A sweep normally runs at most once per 24 hours for
the selected storage root. Changing `retention_days` triggers a fresh sweep.
The attempt is recorded before scanning, so interrupted or unsuccessful sweeps
wait until a later day. If an interactive sweep takes more than about one
second, stderr displays `Checking for old sessions…` before the TUI launches.
Quick sweeps, daily skips, print, JSON, and RPC modes stay silent. Cleanup errors
never prevent a session from starting.

For normal Pi storage, cleanup streams the immediate workspace directories
under `<agent-dir>/sessions` and their session files. An explicit custom session
directory is scanned as one flat directory; there is no arbitrary recursive
walk. Only regular `.jsonl` files older than the retention cutoff are opened,
and only the first 4096 bytes are read to validate a Pi session header.
Malformed headers or a first line that does not fit in that bound are skipped.
Transcript bodies are never loaded. Directory and file symlinks within the
session tree are not followed.

Scheduling state is user state under
`<agent-dir>/pi-sandbox/retention/<root-and-layout-hash>.json`, following
`PI_CODING_AGENT_DIR`. Each record contains the last attempt time and retention
value. Concurrent launches may duplicate a sweep; missing files and failed
deletions are harmless. There is no active-session registry or locking, so a
rare concurrent-resume race remains. This is best-effort housekeeping, not an
enforced data-retention guarantee.

## Network modes

| Mode    | Tool and shell network authority                                                      |
| ------- | ------------------------------------------------------------------------------------- |
| `none`  | Private network namespace with connectable socket creation denied                     |
| `local` | Private network namespace with TCP/UDP on sandbox loopback only; no host Unix sockets |
| `host`  | Complete host network namespace, including host loopback, LAN, and Internet           |

`local` retains an isolated namespace with only loopback and no external routes.
`localhost` refers to this sandbox, not the host or another Pi process. No port
forwarding or host access is provided, even when a server binds `0.0.0.0` or `::`.
Named Unix sockets are unavailable, including sandbox-local pathname sockets;
anonymous connected Unix stream pairs remain available for process IPC.

`host` is deliberately unrestricted. Bubblewrap does not provide IP, port,
hostname, or destination filtering, and Pi Sandbox does not imply such filtering
when this mode is selected. There is no dedicated network CLI or environment
override; the selected TOML supplies the mode. In broker
mode, an administrator-owned user/group rule may replace the base network mode.
Provider traffic from host-side Pi is unaffected by these settings.

`direct` requires `host`. This requirement is checked both for the base TOML
and after broker execution and network overrides are applied.

Managed host tools are unaffected by this table: they deliberately use the
invoking user's host network namespace and ordinary host controls.

## Background process lifetime

Optional `execution.process_lifetime` defaults to `command`, which removes all
remaining sandbox command processes after every operation. With `sandbox`,
background processes survive ordinary foreground completion, including nonzero
exit codes, and remain available to subsequent calls. Lifetime covers the whole
`pi-sandbox` process, including changes of logical Pi session. The existing worker
runs up to four commands concurrently in this mode; `command` lifetime stays
serial. At most 64 requests may be outstanding, including active calls and queued
work. Further submissions fail with `sandbox_queue_full` without interrupting
admitted work. These are fixed backend limits, not additional TOML settings.
No watcher or daemon is involved. This setting is independent of network mode.

For a server reachable by later sandbox calls:

```toml
[execution]
backend = "bubblewrap"
process_lifetime = "sandbox"

[network]
mode = "local"
```

Start it with input/output redirected, for example
`my-server </dev/null >server.log 2>&1 &`, then use `curl http://localhost:PORT`
in a later call. In persistence mode, output completion matches pinned Pi 1.1.0:
after foreground exit, wait for stream closure or 100 ms without output. Each
chunk restarts the idle timer; continued output can defer completion under the
existing command timeout and output limits. There is no separate absolute drain
deadline. Completion closes that call's streams, so an unredirected background
writer may receive a broken-pipe error on a later write.

Cancelling active work, exceeding its timeout/output limit, or an execution
failure interrupts other active calls and cleans up the sandbox's command
processes, including previously started servers, before queued work may start.
Each interrupted call reports a failure. Cancelling a queued request only removes
that request. Closing Pi
terminates the entire sandbox. A completed call's timeout/output limits do not
impose a duration or disk quota on its surviving background processes.

Direct execution requires `process_lifetime = "command"`; its behavior is
unchanged. Administrator user/group overrides may set process lifetime, and the
effective combination is validated after merging.

## Compiled extensions

Extension selection is an administrative runtime choice within the catalog
fixed at build time. `[extensions]` is required even when empty. Selecting an
extension enables its configuration and adds its tool names to the exact
required policy set; `mode = "disabled"` hides a selected tool but does not
remove the requirement to state its policy. User/group broker drop-ins can replace
policies for selected tools, but cannot select extensions or change extension
configuration.

Managed extensions declare a host-environment contract. That
contract lists which managed variable names the extension accepts from the
effective configuration or same-named ambient environment, which inherited names or prefixes it
removes, and any fixed values it applies. Other ordinary ambient host variables
remain available unless the contract removes them. A configured environment for an
unselected extension or an undeclared variable fails startup. Pi-scoped values
and values declared for other extensions are excluded from the extension's host
executor. The Git extension accepts no configured variables. Standard
`pi-tool` extensions have an empty Pi Sandbox configuration and environment
contract; they use ordinary Pi extension code compiled into the application.

The Git extension accepts only:

```toml
[extensions.git]
allowed_hosts = ["github.com"]
allowed_schemes = ["https", "ssh"]
```

Hosts are normalized and compared as exact names; entries do not imply
subdomains or wildcards. Schemes control the accepted locator syntax. HTTP and
HTTPS URLs, `ssh://` URLs, and SCP-style SSH locators are accepted only when
their parsed scheme and host are allowed. Local paths, `file:` and external
remote-helper schemes, control characters, HTTP credentials containing a
password, and locators without a safe repository basename are rejected. The
target is always one derived immediate child of the launch CWD.

This check validates the locator presented by the model, not the ultimate
network destination. The compiled Git environment disables global and system
Git configuration, URL rewrites, credential prompting, and Git-selected SSH
commands. User SSH configuration such as `HostName` or `ProxyJump`, DNS, HTTP
proxies, and redirects can still lead elsewhere. `allowed_hosts` is a locator
allowlist, not an egress firewall.

An extension manifest declares `kind = managed` or `kind = pi-tool` and its
exact tool names. Managed extensions use the Pi Sandbox SDK for strongly typed,
bounded host-command execution. A standard Pi tool extension exports an
ordinary Pi extension factory; at startup it may use only `registerTool` and
`exec`, and its actual registrations must exactly match the manifest. Both
kinds receive the same invocation policy. Standard extension code is trusted
host code and is not contained by the policy wrapper.

## Policy modes

| Mode       | Model tool                                   |
| ---------- | -------------------------------------------- |
| `allow`    | Present and executed without a prompt        |
| `ask`      | Present and requires interactive approval    |
| `deny`     | Present as a fail-closed guard, but rejected |
| `disabled` | Omitted from the model catalog               |

`deny` and `disabled` are intentionally distinct. Disabled model tools are not
advertised to the model. A denied subject remains policy-addressable and rejects
stale or forced calls.

## Session grants

`session_grant` controls which choices are presented when `mode = "ask"`:

- `never`: offer only **Allow once** and **Deny**;
- `offer`: also offer **Allow for session**.

The setting is independent for every model tool. For example, an operator may
offer session grants for `read` but never for `bash` or `write`.

Accepted session grants:

- live only in the current logical Pi session;
- are never written to disk;
- apply only to the exact approval subject;
- are discarded when the session changes or Pi exits; and
- never alter filesystem, environment, or network authority.

An `edit` grant does not authorize `write`, and no grant can enable a disabled
tool. User `!` shell does not use grants or approval policy.

## Interactive diagnostics

Pi Sandbox registers one read-only diagnostic command:

```text
/sandbox
/sandbox mounts
/sandbox policy
/sandbox policy write
/sandbox mcp
/sandbox mcp docs
```

`/sandbox` reports whether the selected backend is initialized, its process
lifetime, execution backend, launch directory, selected configuration path,
effective selected model file, identity mode, effective network mode, CWD access,
user-state directory, code-mode enablement, and MCP server count. `/sandbox mounts` reports the semantic Bubblewrap mount
policy or explicitly reports that direct mode has no mount boundary.
`/sandbox policy` lists every configured model-tool
mode, the fixed user-shell behavior, session-grant options, and current
memory-only grants; an optional subject shows its scope in more detail.

The command uses the configuration already admitted at startup and the mount
plan used to create Bubblewrap. It does not rerun a shell command, reread
configuration, change policy, create grants, print model definitions, expand
environment variables, or expose credentials. The diagnostic subject list is
the exact configured model-tool set plus `user_shell`. Diagnostics distinguish
sandbox, direct, and managed-host execution scopes and list the selected
compiled extensions.

## Prompt behavior

The extension freezes an exact request snapshot before policy evaluation and
executes that same snapshot after approval. Pi's built-in renderers present
their normal request details, except that edit calls show only the path: Pi's
edit diff preview reads the target file in the host process before approval, so
Pi Sandbox replaces it for every edit call, including while `edit` is disabled.
Managed API version 3 tools may provide a short, single-line call summary that
Pi Sandbox bounds and renders in the same tool card. `git_clone` shows its
repository locator. A standard Pi extension keeps its own tool renderer, if
supplied. The approval selector includes a bounded path, command, or argument
preview alongside the subject and configured choices. Nested code-mode tools do
not have an independent call card, so the selector identifies their operation.
MCP prompts show the original server/tool name. The internal integrity
fingerprint is not displayed.

An approval-required operation is denied when:

- Pi has no interactive UI;
- the prompt is cancelled or times out;
- the session shuts down;
- prompt rendering or policy evaluation fails.

## Bash scope

Model Bash uses the configured `tools.bash` policy. Explicit user `!` shell is
always allowed without a prompt because it is an action directly invoked by the
user. Both use the configured backend. In direct mode they run as the current
user without filesystem or network containment.

Pi 1.0's `user_bash` replacement-result API does not expose live progress without
using its stock operations, whose truncation path writes an artifact to host
temporary storage. Pi Sandbox intentionally returns one final bounded, sanitized
user-shell result instead. Model Bash retains ordinary tool update rendering;
both result paths remove ANSI escapes, carriage returns, and unsafe controls.
Model Bash defaults to a 120-second sandbox timeout and accepts an explicit
timeout greater than zero through 600 seconds. User `!` shell always uses the
fixed 120-second timeout and has no per-command override.

In Bubblewrap, either kind of shell command can read the ordinary host
filesystem and write private temporary state. It can write inside the launch
CWD only when `filesystem.cwd_writable = true`; the rest of the ordinary host
filesystem remains read-only. Its network authority is the effective `network`
mode. Structured-tool policies do not intercept file or network operations
performed by Bash.

## Tool event logging

The configuration requires an `[audit]` table with `enabled` and
`facility`, and an `audit` boolean in every base `[tools.<name>]` policy.
`facility` is one of `local0` through `local7`. The fixed syslog identifier is
`pi-sandbox`. Packaged defaults disable the feature globally, select `local0`,
and mark write, edit, and Bash tools for logging while leaving
read/search tools unlogged. Set `enabled = true` to activate the collector
connection on Linux. macOS requires `enabled = false`.

A tool's boolean selects its permission-decision and execution lifecycle events.
It does not change tool visibility, approval, or execution authority. Session
lifecycle events are emitted whenever logging is enabled, independently of the
individual tool selections. Human `!` commands are excluded.

These settings belong exclusively to the parent configuration. user/group rules
cannot contain `[audit]` or tool-level `audit` fields. A combined override replaces
its tool's invocation permissions while retaining the parent's logging choice.

Logged fields identify the tool, execution boundary, permission decision,
invocation, Pi session, and outcome. File tools include their resolved absolute
target path or search root; they exclude file offsets, file contents, edit
diffs, search expressions, and tool output. Bash includes bounded command text
and an explicit truncation flag. Its command limit is 4096 bytes of JSON-escaped text; escaped characters
count toward that bound. Invalid target paths are omitted, and command capture
stops before a NUL or an unpaired Unicode surrogate with the truncation flag set. Commands may themselves contain inline
content or credentials; length limits do not redact them. Session events include
the captured launch CWD. Records use JSON escaping to remain single-line.

Before an admitted logged tool runs, its execution-intent record must be
acknowledged by the collector. Acknowledgment means successful submission to
local syslog, not storage or remote delivery. Submission failure prevents new
logged operations. Failure to submit a completion record never retries the
operation; its externally observable outcome may remain unknown.

Managed extension definitions may supply an optional `auditTarget` function
that selects only an absolute `path` and/or repository locator from the same
immutable arguments used for execution. The Git clone tool records its validated
repository locator and derived destination. Other compiled tools without this
function record tool identity, permission decisions, and outcomes only.

## smolvm image and runtime selection

The optional Linux x86-64 backend uses a complete, fixed smolvm **1.25.4**
distribution. The distribution manifest, not runtime configuration or an
identity rule, selects its absolute wrapper path:

```toml
[platforms.linux.smolvm]
path = "/opt/smolvm-1.25.4/smolvm"
version = "1.25.4"
```

This extends distribution format 3. The runtime, adjacent libraries and guest
rootfs are external prerequisites, not included in the Pi archive. Startup
verifies their pinned inventory before using them. Selecting smolvm without a
build-selected provider fails; there is no fallback to another executor.

Main configuration format **11** provides the image and resource policy:

```toml
[execution]
backend = "smolvm"

[network]
mode = "none"

[filesystem]
cwd_writable = true
hidden_paths = []

[smolvm]
image = "/opt/pi-images/tools.smolmachine"
image_sha256 = "REPLACE_WITH_THE_IMAGE_SHA256"
state_directory = "/var/tmp/pi-vm-{{uid}}"
cpus = 2
memory_mib = 1024
storage_gib = 1
overlay_gib = 1
```

Replace the digest with exactly 64 lowercase hexadecimal characters and choose
a private state path for the invoking account outside the project. The image
path remains literal. The state directory accepts `{{uid}}` and `{{username}}`
using the same trusted account lookup as the scoped environment, before any
managed `HOME` takes effect. The expanded value must be a normalized absolute
path below `/`, contain no colon and occupy at most 48 bytes. Provision this
directory for each account before use, owned by that account with mode `0700`.
For example, the template above selects `/var/tmp/pi-vm-1001` for UID 1001.
Startup verifies canonical paths, private ownership and placement outside the
project; it does not create or change permissions on this account directory.
CPU count is 1–32; memory is 256–65536 MiB; each disk is 1–64 GiB. The trusted
image must supply the executor's fixed Linux tools. Host GNU tools, `fd` and
`rg` are not prerequisites for VM tool execution; host extensions retain their
own executable prerequisites.
For the separate OCI controller, smaller-than-template disk capacities require
host `resize2fs` from e2fsprogs. See the
[runtime prerequisites](installation.md#optional-external-smolvm-runtime).
Prepared plain packs use their already-sized templates; capacities below the
image's logical disk sizes are rejected instead of shrinking them at launch.

The `[smolvm]` table is optional for other backends. It may be present in a
Bubblewrap base policy when an identity rule is allowed to select smolvm.
Identity rules cannot replace the image, digest, private state location,
resources or pinned runtime. The complete effective configuration is validated
after identity selection.

smolvm has one fixed process lifetime: background processes survive ordinary
tool completion until the VM stops. Do not set `execution.process_lifetime`
for this backend. The field remains a Bubblewrap choice, while direct execution
requires `command`. VM networking is offline, and `hidden_paths` must be empty
because other host paths are not mounted. The launch directory remains at its
same absolute path and follows `cwd_writable`; private guest files are writable.
MCP and managed host extensions remain host-side and retain their policies.

Up to four commands run concurrently, with a fixed limit of 64 outstanding
requests including the queue. Per-call timeouts include queue wait. Cancelling
or timing out a queued call leaves running work intact; active cancellation,
timeout, output overflow or execution infrastructure failure retires the VM and
interrupts its other calls and background processes. Further calls require a new
executor. Ordinary nonzero exits keep the VM available. Output follows Pi's
100 ms post-exit idle drain, resetting with each chunk; continuous background
output can keep a call open until its timeout or output limit. Redirect background
server output to files.

Normal Pi shutdown stops and deletes the owned VM. If Pi is killed or crashes,
a VM may remain. There is no separate watcher process. Use the recorded private
state and the smolvm CLI to list and stop those machines before deleting their
state. A failed cleanup preserves state for recovery instead of claiming the VM
was removed.
