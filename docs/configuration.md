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
backend, network mode, CWD write access, and any subset of model-tool policies. If no rules match,
the main configuration remains unchanged. See
[user and group environment and overrides](identity-broker.md).

The required `execution` table selects `bubblewrap`, `seatbelt`, or `direct`. Bubblewrap is
available only on Linux. Direct execution is available on Linux and macOS and
runs approved built-in operations with the invoking user's ordinary host
filesystem and process authority. It is an explicit operating mode, never a
fallback after a sandbox failure. Seatbelt is the macOS packaged selection with the distinct contract below. macOS requires `identity.mode = disabled`.

The required `network` table selects `none`, `local`, or `host` for built-in tools and
shell commands. Bubblewrap supports all three. Seatbelt accepts only `none` or `host`; `local` is rejected. Direct execution requires `host` so a
configuration can never claim an isolation mode that the backend does not
enforce. The Linux packaged default is Bubblewrap plus `none`; the macOS
packaged default is Seatbelt plus `none`. Both configuration files explicitly
set `execution.backend`; a missing backend is an error.

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

Pi 1.2.0 preserves ordinary user settings while validating custom themes at
startup. Theme files must follow `https://pi.dev/schemas/theme.schema.json`;
reusable colors belong in `vars`. For SSH or multiplexer clipboard support,
set `PI_CLIPBOARD_OSC52 = "1"` in `environment.pi` to enable Pi's terminal
clipboard escape sequence. This host-side setting does not require or grant
sandbox networking.

### Home-directory and account expansion

Schema 13 expands bare `~` and a leading `~/` in `filesystem.hidden_paths` and `filesystem.denied_paths`,
every configured value under `environment.pi`, `environment.sandbox`, and
`environment.extensions.<id>`, and MCP stdio `env` values. These fields also
accept `{{username}}` and `{{uid}}` anywhere in a string. For example,
`/srv/accounts/{{username}}` becomes `/srv/accounts/alice`, and `~/cache/{{uid}}`
becomes `/home/alice/cache/1001` for that account. On macOS, `filesystem.denied_paths`
and the environment fields listed above also support `{{machine_id}}`, which
expands to the host's hardware UUID (`IOPlatformUUID`). `filesystem.hidden_paths`
is available only with Linux Bubblewrap and cannot resolve this macOS-only macro.

Expansion happens once at operational startup, after broker rules are merged,
using the invoking effective user's canonical OS account name, numeric UID,
and home. It ignores `$HOME`, `$USER`, `$LOGNAME`, `SUDO_USER`, and CWD. The lookup
uses `/usr/bin/getent` on Linux or `/usr/bin/dscacheutil` on macOS, with a cleared
environment, bounded output, and a five-second deadline. Missing account identity
fails operational resolution when needed.

Machine identity is independent of account identity. The application reads it
only when an effective configured value requests `{{machine_id}}`, using fixed
`/usr/sbin/ioreg` with cleared environment, bounded output, and a five-second
deadline. One startup shares the result across policy and MCP resolution; it
does not consult environment variables or a user-selected executable. Values
overwritten during broker merging are not resolved. A referenced machine ID on
an unsupported platform or an unavailable/invalid UUID fails effective policy
startup. A failure used only by an MCP stdio `env` value instead marks that
server `configuration-value-unavailable`. Unused macros trigger no lookup.
Installation validation leaves the macro symbolic and performs no hardware lookup.

The UUID is the same across accounts on a physical Mac and normally survives
OS upgrades, but hardware replacement or VM identity changes can change it.
It is a copyable identifier, not a secret or proof of possession. See the
[model configuration example](models.md#macos-machine-identity).

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
config_version = 13
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
denied_paths = []

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
may override execution backend and network mode and may atomically
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

Managed runs also receive a short environment note identifying the tools' actual
home directory. `$HOME` in Bash and leading `~` in file-tool arguments refer to
that tool home, which can differ from the user's home. When available, the user's
home comes from the effective OS account rather than ambient `HOME` or `USER`.
The note distinguishes policy-restricted locations and the workspace; it does
not grant access or promise that every file beneath the user's home is readable.
Use absolute paths when referring to files in the user's home. The note does not
change HOME, caches, mount policy, or scoped environment settings.

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
bearer_token_from_env = "DOCS_TOKEN"

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
including `Bearer ` for bearer authentication. Alternatively, HTTP-only
`bearer_token_from_env = "DOCS_TOKEN"` reads a raw token from that effective Pi
environment variable and supplies `Authorization: Bearer <token>`. Supply only
the token, without the `Bearer ` prefix or whitespace. This setting cannot be
combined with an `Authorization` entry in either header map, regardless of case;
other headers can still be configured. The generated header counts toward the
same per-value and combined byte limits. Transport-controlled headers and
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

Configuration schema 13 requires all three keys in `[filesystem]`:

```toml
[filesystem]
cwd_writable = true
hidden_paths = []
denied_paths = []
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

Direct execution requires `cwd_writable = true`, `hidden_paths = []`, and `denied_paths = []`; it cannot enforce a read-only
host CWD. Managed host tools remain outside this restriction and can still
write according to their compiled operation and the invoking user's authority.
`cwd_writable` changes write access only. Use `hidden_paths` to remove selected
host file and directory contents from the sandboxed tools' filesystem view.

A root-managed user/group rule may override this setting with
`[overrides.filesystem] cwd_writable = false`. Omission inherits the parent
value. The final backend/filesystem combination is validated after overrides;
switching a read-only base to direct execution also requires overriding
`cwd_writable` to `true`.

### Hidden files and directories (Bubblewrap)

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
denied_paths = []
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

### Denied directories (Seatbelt)

Seatbelt is the macOS packaged default. Start with
`config/default/config.seatbelt.toml`, or use these fields in a complete schema-13
configuration:

```toml
[execution]
backend = "seatbelt"

[network]
mode = "none"

[filesystem]
cwd_writable = false
hidden_paths = []
denied_paths = ["~/.ssh"]
```

`denied_paths` is required in every schema-13 configuration and must be empty
for Bubblewrap and direct execution. Seatbelt requires empty `hidden_paths`.
It accepts up to 63 unique normalized directory paths, with the same account
macros and home expansion as hidden paths. Every expanded target must exist and
be canonical at executor startup; regular files, symlink components and missing
targets fail closed. A denied ancestor restores only the launch CWD subtree;
explicit denials within CWD remain effective. Equality with the launch CWD is
rejected, as are paths that conflict with required runtime grants. Denials
cannot be removed by a user/group override. Denial is an
access error, not an empty filesystem mask; directory entries may remain visible.

`cwd_writable = false` permits reads but denies ordinary writes under CWD.
Real host scratch storage remains writable and supplies HOME and TMPDIR; literal
`/tmp` is not private. `network.mode = "none"` denies network operations through
Seatbelt policy; `host` permits host networking subject to the remaining policy.
There is no isolated loopback mode. Commands complete independently and may overlap.
Process-group and scratch cleanup are best effort. Ordinary foreground completion
may leave background descendants alive even in the same process group. Failure,
cancellation and close signal the group only while the direct child is active;
detached descendants can escape those attempts. Survivors retain their original
grants, including after close or owner death. Changing policy or closing Pi does not revoke a surviving process's
original grants. See [security.md](security.md#macos-seatbelt).

macOS still requires `identity.mode = "disabled"` and `[audit].enabled = false`.
Managed host Git and MCP retain their separate host authority.

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

The following namespace modes describe Bubblewrap. Seatbelt supports `none`
through policy denial and `host` through the shared host network; it rejects
`local` and creates no private namespace.

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

## Command scheduling, timeouts and cleanup

Pi controls tool scheduling, including explicit sequential batches. The executors
add no serial queue, active-command ceiling, or outstanding-request ceiling.
Same-file write/edit coordination still serializes a complete mutation. Transport
backpressure preserves bounded frames without promising bounded total resource
use for arbitrarily many calls. Background writers are not excluded by scheduling.

`execution.max_command_timeout_seconds` is an optional base-policy limit for every
command used by all seven built-in tools and user `!` shell. It accepts positive
finite seconds, including fractions, up to 2147483.647 (the JavaScript timer ceiling).
Values round up to the next millisecond. Omitted means no administrator maximum;
no caller timeout and no maximum means no command timer. With a maximum, an omitted
caller timeout uses that maximum, a shorter timeout is honored, and a larger timeout
is rejected explicitly. The timer starts at successful process launch, after
approvals, same-file coordination and transport waiting. It remains effective
through output draining. A multi-command file operation has a separate clock for
each command, not an aggregate operation deadline. Host Git, MCP and Code Mode keep
their separate timing contracts. User/group rules cannot override this maximum.

```toml
[execution]
backend = "bubblewrap"
# Optional; omit for ordinary Pi's uncapped default.
max_command_timeout_seconds = 3600
```

Commands complete independently. Background descendants may survive ordinary
completion, including a nonzero exit, and logical session changes. Redirect a
server's input and output, for example `my-server </dev/null >server.log 2>&1 &`.
After foreground exit, completion waits for closed streams or 100 ms without
output; every chunk restarts that idle timer. Continued output can defer unlimited
commands subject to the output bound. There is no additional absolute drain
deadline. Completion closes streams; later writes may receive a broken pipe.

Cancellation, timeout, output overflow, callback failure and spawn failure affect
only their request. Cancellation before launch prevents execution. Active cleanup
is best-effort process-group termination; detached descendants may remain. After
the direct child exits, cancellation/close detaches its streams without signalling
its old PID or process group. No normal completion or individual failure sweeps
all sandbox processes. Linux executor shutdown retains the final namespace
boundary; fatal worker/transport failure may abort the executor. Direct and
Seatbelt cleanup is best effort. Seatbelt survivors retain their original grants
after close or owner death; no watcher, helper or grant revocation is provided.

The removed `process_lifetime` field is rejected by managed schema 13. There is
one lifecycle contract rather than separate command and sandbox modes.

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
tool. User `!` shell does not use grants or approval policy. With a Bash
`known_read_only` class policy, a grant accepted for a known read-only command
covers only later known read-only commands; see
[scoped grants](#prompts-and-scoped-session-grants).

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
memory-only grants; an optional subject shows its scope in more detail. A Bash
class policy adds its own row and detail; see
[diagnostics](#known-read-only-diagnostics).

The command uses the configuration already admitted at startup and the mount
plan used to create Bubblewrap. It does not rerun a shell command, reread
configuration, change policy, create grants, print model definitions, expand
environment variables, or expose credentials. The diagnostic subject list is
the exact configured model-tool set plus `user_shell`. Diagnostics distinguish
sandbox, direct, and managed-host execution scopes and list the selected
compiled extensions.

## Prompt behavior

The extension freezes an exact request snapshot before policy evaluation and
executes that same snapshot after approval. File-tool call cards preserve
absolute paths instead of shortening the Pi process's home to `~`. Explicit
`~` and `~/...` arguments carry a `tool home` label and have no host-file link;
historical calls are not reinterpreted against a new executor's home. Read line
ranges, search options, and write content previews remain visible. Edit calls
show only the path: Pi's edit diff preview reads the target file in the host
process before approval, so Pi Sandbox replaces it for every edit call,
including while `edit` is disabled. Call presentation uses Pi's extension
renderer API; execution arguments, result content, and Bash command text are
unchanged.
Existing absolute-path links navigate the host filesystem; they do not establish
that a private or externally supplied executor exposes the same file there.
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

Model Bash uses the configured `tools.bash` policy, refined by an optional
[known read-only class policy](#known-read-only-bash-commands). Explicit user `!` shell is
always allowed without a prompt because it is an action directly invoked by the
user. Both use the configured backend. In direct mode they run as the current
user without filesystem or network containment.

Pi 1.0's `user_bash` replacement-result API does not expose live progress without
using its stock operations, whose truncation path writes an artifact to host
temporary storage. Pi Sandbox intentionally returns one final bounded, sanitized
user-shell result instead. Model Bash retains ordinary tool update rendering;
both result paths remove ANSI escapes, carriage returns, and unsafe controls.
Model Bash accepts an optional positive finite timeout in seconds up to 2147483.647.
There is no implicit timeout. The optional administrator command maximum applies
to both model Bash and user `!` shell; user shell has no per-command override.

In Bubblewrap, either kind of shell command can read the ordinary host
filesystem and write private temporary state. It can write inside the launch
CWD only when `filesystem.cwd_writable = true`; the rest of the ordinary host
filesystem remains read-only. Its network authority is the effective `network`
mode. Structured-tool policies do not intercept file or network operations
performed by Bash.

## Known read-only Bash commands

An optional class policy lets model Bash commands that Pi Sandbox recognizes as
read-only use a more permissive policy than other Bash commands:

```toml
[tools.bash]
mode = "deny"
session_grant = "never"
audit = true

[tools.bash.known_read_only]
mode = "allow"
session_grant = "never"
```

`[tools.bash]` remains the main policy for every command the class does not
cover. When the effective Bash policy has a class policy, Pi Sandbox analyzes
the exact command text of each model `bash` call before preparing its approval
request and classifies it as `known_read_only` or `unclassified`. Classification
selects only the approval policy. An approved command runs unchanged as
`bash -c <command>` through the selected backend with the same filesystem,
network and environment authority as any other approved Bash command. Without
the table, Bash is not analyzed and behavior is unchanged. See
[security](security.md#known-read-only-bash-commands) for the guarantee and its
limits.

"Known" means listed in a reviewed, compiled-in registry. The registry is
intentionally not exhaustive: an unlisted command that only reads, or a listed
command with an unlisted option, is unclassified and uses the main policy.

### Class policy validation

The table is an additive optional field of configuration schema 13. It accepts
exactly `mode` (`allow`, `ask` or `deny`) and `session_grant` (`never` or
`offer`). Availability remains tool-level: `disabled` is not a class mode, and
`audit` stays on `[tools.bash]`. Each violation is reported in the ordinary
`Invalid pi-sandbox configuration in <path>:` list:

1. The table is accepted only under `[tools.bash]`. Elsewhere it is
   `config.tools.<tool>.known_read_only is not a recognized field`. A non-table
   value is `config.tools.bash.known_read_only must be a table`.
2. Missing or extra fields report
   `config.tools.bash.known_read_only.<field> is required` or
   `config.tools.bash.known_read_only.<field> is not a recognized field`.
   Invalid values report
   `config.tools.bash.known_read_only.mode must be one of: allow, ask, deny` or
   `config.tools.bash.known_read_only.session_grant must be one of: never, offer`.
3. `offer` requires `ask`:
   `config.tools.bash.known_read_only.session_grant may be "offer" only when mode is "ask"`.
4. The class policy must be strictly more permissive than the main policy:
   `config.tools.bash.known_read_only must be strictly more permissive than config.tools.bash (mode deny < ask < allow, or ask with session_grant "offer" over "never"); otherwise it has no effect`.
5. A class policy is not permitted under a disabled main policy:
   `config.tools.bash.known_read_only is not permitted when config.tools.bash.mode is "disabled"; availability is tool-level only`.
6. Class `allow` requires `read`, `grep`, `find` and `ls` to be `allow`, one
   issue per tool:
   `config.tools.bash.known_read_only.mode "allow" requires config.tools.<tool>.mode "allow" (it is "<mode>")`.

Rule 4 exists because the model chooses the command text and can always move a
command out of the class, for example by adding a variable or an unlisted
option. A class policy stricter than the main policy would protect nothing, so
it is rejected rather than silently ignored. Rule 6 makes skipping the prompt
justified: the typed read and search tools can already observe the same data
without a prompt.

Broker rule files carry the same table with the same per-file rules. After user
and group rules are applied, rule 6 is checked again on the effective policy and
startup fails with:

```text
effective tool policy after identity overrides is invalid: tools.bash.known_read_only.mode "allow" requires tools.<tool>.mode "allow" (it is "<mode>"); allow read, grep, find, ls or use a stricter bash.known_read_only mode in the base configuration or identity broker rules
```

See [identity broker](identity-broker.md#known-read-only-bash-class) for
merging and replacement.

### Decisions

Modes are ordered `deny < ask < allow` and session options `never < offer`.
Unclassified commands use the main policy. Known read-only commands use the
join of both policies: the greater mode and the greater session option, keeping
`offer` only when the joined mode is `ask`. Because every accepted class policy
is strictly more permissive, the join equals the class policy. Every accepted
combination:

| `[tools.bash]` | `known_read_only` | Unclassified commands                | Known read-only commands                |
| -------------- | ----------------- | ------------------------------------ | --------------------------------------- |
| `deny`         | `ask`/`never`     | Denied with feedback                 | Prompted: **Allow once**, **Deny**      |
| `deny`         | `ask`/`offer`     | Denied with feedback                 | Prompted, with the class session choice |
| `deny`         | `allow`           | Denied with feedback                 | Run without a prompt                    |
| `ask`/`never`  | `ask`/`offer`     | Prompted: **Allow once**, **Deny**   | Prompted, with the class session choice |
| `ask`/`never`  | `allow`           | Prompted: **Allow once**, **Deny**   | Run without a prompt                    |
| `ask`/`offer`  | `allow`           | Prompted, with **Allow for session** | Run without a prompt                    |

`deny` plus a class policy runs only known read-only commands. Every other
combination, including any class policy under `allow` or `disabled`, is
rejected. Prompted requests are denied as usual without an interactive UI.

### Prompts and scoped session grants

Known read-only approval prompts use the subject label `bash (known read-only)`,
for example `Allow bash (known read-only): ls -la src?`. Unclassified prompts
keep `Allow bash: <command>?`.

Session grants are scoped by the class of the request that created them:

- **Allow for session** on an unclassified command has tool scope and covers
  every later Bash command;
- **Allow known read-only commands for session** on a known read-only command
  has class scope and covers only later known read-only commands.

Both remain memory-only and are cleared with every session lifecycle event that
clears other grants. Changing either the main or the class policy invalidates
them. A class grant is broad: it admits every later known read-only command,
including reads of any path visible to the selected backend.

### Denial feedback

When the main policy denies an unclassified command, the error returned to the
model names the first reason the command was not recognized, so the model can
use a dedicated tool or a simpler command instead of retrying:

```text
Pi Sandbox denied bash: policy_denied; not a known read-only command: <reason>
```

For example, `touch x` reports `"touch" is not a known read-only command`. The
reason is a printable-ASCII, plain-English explanation of at most about 160
characters that quotes the command only as short escaped excerpts. An unsafe
command-wide environment variable or locale is reported first; otherwise the
first problem in source order is reported. Pi Sandbox additionally limits the
reason, including any ellipsis, to 512 bytes and replaces control characters.
If analysis fails or returns an invalid result, the command is unclassified and
the reason is `command analysis failed`. Prompt denials,
cancellation, missing UI and `disabled` keep their ordinary messages. Without a
class policy, denials are unchanged.

### Recognized syntax

The analyzer never executes, expands or resolves the command through a shell.
It accepts only a literal subset of Bash whose meaning is the same in GNU Bash
3.2 and later under `bash -c`; anything else is unclassified, with no attempt to
recover:

- **Input:** at most 16 KiB of UTF-8. Control characters other than tab and
  newline, DEL and invalid Unicode are rejected even inside quotes. Non-ASCII
  characters are accepted only inside quotes, and only when the execution
  locale is C, POSIX or UTF-8.
- **Words:** unquoted letters, digits and `_ . / , : @ % + = -`; single-quoted
  text; and double-quoted text without `"`, `\`, `$`, `` ` `` or `!`. There are
  no variables, command substitution, globs, brace or tilde expansion, escapes,
  comments, line continuations, arithmetic, process substitution, subshells or
  grouping.
- **Structure:** commands joined by `|` into pipelines, pipelines joined by `&&`
  or `||`, and statements separated by `;` or newlines. A newline directly after
  `&&`, `||` or `|` continues the command. Leading, trailing and repeated
  newlines and one trailing `;` are allowed. Empty statements, `;;`, background
  `&`, `|&`, `!` and parentheses are rejected.
- **Commands:** the first word of every stage must exactly match a registry
  command name. Unquoted reserved words such as `if`, `time` or `coproc`,
  assignment-shaped words such as `LC_ALL=C sort`, and paths such as `/bin/cat`
  are rejected. Every branch of `&&`, `||` and `;` is checked; control flow is
  not evaluated.

Redirections may appear anywhere in a stage, with optional blanks before the
target. A digit-only word written immediately before `<` or `>` is the
descriptor number, and only descriptors 0, 1 and 2 are accepted:

| Form                                                                                      | Meaning                             |
| ----------------------------------------------------------------------------------------- | ----------------------------------- |
| `>/dev/null`, `>>/dev/null`, `1>/dev/null`, `2>/dev/null`, `1>>/dev/null`, `2>>/dev/null` | Discard the stream                  |
| `&>/dev/null`                                                                             | Discard stdout and stderr           |
| `2>&1`, `1>&2`, `>&1`, `>&2`, `2>&2`, `1>&1`                                              | Duplicate between stdout and stderr |
| `<file`, `0<file`                                                                         | Read a file                         |

Discard targets must be exactly `/dev/null`, and duplication targets an unquoted
`1` or `2`. Input targets cannot name `/dev/tcp` or `/dev/udp`, including
spellings with repeated slashes. Output to any file, other descriptors, `<&`,
`>&-`, `<>`, `>|`, `&>>`, here-documents, here-strings and statements consisting
only of redirections are rejected.

A command is also unclassified when the execution environment could change which
program runs or how Bash starts, or make every program load code or write files:
for example a project-local executable earlier in `PATH`, an exported Bash
function, a non-empty `BASH_ENV`, `SHELLOPTS`, `BASHOPTS` or `EXECIGNORE`, or
any non-empty `LD_*`, `DYLD_*` or `GCONV_PATH` variable. See
[execution-context checks](security.md#execution-context-checks).

### Known read-only command registry

Registry version 1 contains the shell builtins `cd`, `echo`, `false`, `pwd` and
`true`, and the executables `basename`, `cat`, `cut`, `diff`, `dirname`, `du`,
`find`, `grep`, `head`, `ls`, `nl`, `readlink`, `realpath`, `rg`, `sed`, `sort`,
`stat`, `tail`, `tr`, `uniq` and `wc`. Builtins are not resolved through `PATH`;
executables must resolve outside the launch directory.

The table below is generated from the registry and is the complete accepted
set: any option or operand form it does not list makes the command unclassified.
Parsing follows GNU `getopt_long`, the most permissive interpretation across the
implementations considered: GNU coreutils, findutils, grep and sed; uutils
coreutils; and the BSD and macOS userland. Busybox applets are not covered.
Long options must be spelled in full, because GNU and uutils accept
abbreviations; short options may be clustered; `--` ends options; and options
after operands are still checked. Options whose meaning differs or is doubtful
on any considered implementation are omitted. A few accepted options take
values differently, which changes only which words are read as data: BSD
`stat -f` and `-t` take a format argument, so the next word becomes a format
instead of a file, and BSD `grep --context` and `diff --context` or `--unified`
take only an optional attached value. Operand limits count every word
after the first operand, as implementations that stop option parsing there
would: `uniq a -c` is rejected because BSD `uniq` would write a file named
`-c`. Option values and file operands are data or paths to read; paths are not
confined, so any path visible to the backend may be read.

Notable exclusions include `find -exec`, `-execdir`, `-ok`, `-okdir`,
`-delete`, `-fprint`, `-fprint0`, `-fprintf`, `-fls` and unknown primaries;
`rg --pre`, `--pre-glob`, `-z`/`--search-zip` and `--hostname-bin`; every `sed`
use except `-n` (or `--quiet`/`--silent`, one of which is required) with one
`Np`, `N,Mp`, `$p` or `N,$p` script and at most one file; `sort -o`, `-T` and
`--compress-program`; `tail -f`, `-F`, `--follow`, `--retry`, `--pid` and `-s`;
a second `uniq` operand, which names an output file; and BSD `cat -l`. `rg` is
unclassified while `RIPGREP_CONFIG_PATH` is set unless `--no-config` is given,
and `grep` while `GREP_OPTIONS` is set. `cd` accepts at most one operand and
changes only the directory of the same `bash -c` process. `git`, interpreters
and shells, wrappers such as `env`, `xargs`, `timeout` and `command`,
network-capable tools, pagers, editors and `printf` are not in the registry.
Each registry change increments its version, which diagnostics and event records
report. To regenerate the table after a registry change, run
`PI_SANDBOX_UPDATE_DOCS=1 npx vitest run src/permissions/known-read-only-docs.test.ts`.

<!-- known-read-only-commands:start -->

<!-- prettier-ignore -->
| Command | Kind | Accepted options and operands |
| --- | --- | --- |
| `basename` | executable | Options: `-a`/`--multiple`, `-s SUFFIX`/`--suffix=SUFFIX`, `-z`/`--zero`. Operands: names (not read). |
| `cat` | executable | Options: `-A`/`--show-all`, `-b`/`--number-nonblank`, `-e`, `-E`/`--show-ends`, `-n`/`--number`, `-s`/`--squeeze-blank`, `-t`, `-T`/`--show-tabs`, `-u`, `-v`/`--show-nonprinting`. Operands: files to read. |
| `cd` | shell builtin | Options: `-L`, `-P`. Operands: at most one directory. |
| `cut` | executable | Options: `-b LIST`/`--bytes=LIST`, `-c LIST`/`--characters=LIST`, `-d DELIM`/`--delimiter=DELIM`, `-f LIST`/`--fields=LIST`, `-n`, `-s`/`--only-delimited`, `-z`/`--zero-terminated`, `--complement`, `--output-delimiter=STRING`. Operands: files to read. |
| `diff` | executable | Options: `-a`/`--text`, `-b`/`--ignore-space-change`, `-B`/`--ignore-blank-lines`, `-c`, `-C NUM`, `--context[=NUM]`, `-d`/`--minimal`, `-i`/`--ignore-case`, `-I RE`/`--ignore-matching-lines=RE`, `-N`/`--new-file`, `-p`/`--show-c-function`, `-q`/`--brief`, `-r`/`--recursive`, `-s`/`--report-identical-files`, `-t`/`--expand-tabs`, `-T`/`--initial-tab`, `-u`, `-U NUM`, `--unified[=NUM]`, `-w`/`--ignore-all-space`, `-W NUM`/`--width=NUM`, `-x PAT`/`--exclude=PAT`, `-X FILE`/`--exclude-from=FILE`, `-y`/`--side-by-side`, `--normal`, `--strip-trailing-cr`, `--suppress-common-lines`, `--color[=WHEN]`. Operands: files or directories to compare. |
| `dirname` | executable | Options: `-z`/`--zero`. Operands: names (not read). |
| `du` | executable | Options: `-a`/`--all`, `-c`/`--total`, `-d N`/`--max-depth=N`, `-h`/`--human-readable`, `-H`, `-k`, `-L`/`--dereference`, `-m`, `-P`/`--no-dereference`, `-s`/`--summarize`, `-x`/`--one-file-system`, `--apparent-size`, `--si`. Operands: files or directories to measure. |
| `echo` | shell builtin | Any words; output only. |
| `false` | shell builtin | Any words (ignored). |
| `find` | executable | Leading options: `-H`, `-L`, `-P`. Operands: starting paths, then an expression of operators `(`, `)`, `!`, `-not`, `-a`, `-and`, `-o`, `-or`; primaries without arguments `-depth`, `-empty`, `-executable`, `-false`, `-follow`, `-ls`, `-mount`, `-nogroup`, `-noleaf`, `-nouser`, `-print`, `-print0`, `-prune`, `-quit`, `-readable`, `-true`, `-writable`, `-xdev`; primaries with one argument `-amin`, `-anewer`, `-atime`, `-cmin`, `-cnewer`, `-ctime`, `-fstype`, `-gid`, `-group`, `-ilname`, `-iname`, `-inum`, `-ipath`, `-iregex`, `-iwholename`, `-links`, `-lname`, `-maxdepth`, `-mindepth`, `-mmin`, `-mtime`, `-name`, `-newer`, `-path`, `-perm`, `-printf`, `-regex`, `-regextype`, `-samefile`, `-size`, `-type`, `-uid`, `-user`, `-wholename`, `-newerXY` (`XY` from `aBcm` then `aBcmt`). |
| `grep` | executable | Options: `-E`/`--extended-regexp`, `-F`/`--fixed-strings`, `-G`/`--basic-regexp`, `-P`/`--perl-regexp`, `-e PATTERNS`/`--regexp=PATTERNS`, `-f FILE`/`--file=FILE`, `-i`/`--ignore-case`, `-w`/`--word-regexp`, `-x`/`--line-regexp`, `-s`/`--no-messages`, `-v`/`--invert-match`, `-m NUM`/`--max-count=NUM`, `-b`/`--byte-offset`, `-n`/`--line-number`, `--line-buffered`, `-H`/`--with-filename`, `-h`/`--no-filename`, `-o`/`--only-matching`, `-q`/`--quiet`, `--silent`, `-a`/`--text`, `-I`, `-r`/`--recursive`, `-R`/`--dereference-recursive`, `--include=GLOB`, `--exclude=GLOB`, `--exclude-dir=GLOB`, `-L`/`--files-without-match`, `-l`/`--files-with-matches`, `-c`/`--count`, `-A NUM`/`--after-context=NUM`, `-B NUM`/`--before-context=NUM`, `-C NUM`/`--context=NUM`, `--color[=WHEN]`, `--colour[=WHEN]`. Operands: a pattern (unless `-e`/`-f`), then files or directories to read. Unclassified while `GREP_OPTIONS` is non-empty. |
| `head` | executable | Options: `-c NUM`/`--bytes=NUM`, `-n NUM`/`--lines=NUM`, `-q`/`--quiet`, `--silent`, `-v`/`--verbose`, `-NUM`. Operands: files to read. |
| `ls` | executable | Options: `-1`, `-a`/`--all`, `-A`/`--almost-all`, `-C`, `-c`, `-d`/`--directory`, `-F`, `--classify[=WHEN]`, `--color[=WHEN]`, `-g`, `-H`/`--dereference-command-line`, `-h`/`--human-readable`, `-i`/`--inode`, `-k`, `-L`/`--dereference`, `-l`, `-m`, `-n`/`--numeric-uid-gid`, `-o`, `-p`, `-R`/`--recursive`, `-r`/`--reverse`, `-S`, `-s`/`--size`, `-t`, `-u`, `-x`, `--full-time`, `--group-directories-first`, `--sort=WORD`, `--time=WORD`. Operands: files or directories to list. |
| `nl` | executable | Options: `-b STYLE`/`--body-numbering=STYLE`, `-d CC`/`--section-delimiter=CC`, `-f STYLE`/`--footer-numbering=STYLE`, `-h STYLE`/`--header-numbering=STYLE`, `-i NUM`/`--line-increment=NUM`, `-l NUM`/`--join-blank-lines=NUM`, `-n FORMAT`/`--number-format=FORMAT`, `-p`/`--no-renumber`, `-s STRING`/`--number-separator=STRING`, `-v NUM`/`--starting-line-number=NUM`, `-w NUM`/`--number-width=NUM`. Operands: files to read. |
| `pwd` | shell builtin | Options: `-L`, `-P`. Operands: none. |
| `readlink` | executable | Options: `-f`/`--canonicalize`, `-e`/`--canonicalize-existing`, `-m`/`--canonicalize-missing`, `-n`/`--no-newline`, `-q`/`--quiet`, `-s`/`--silent`, `-v`/`--verbose`, `-z`/`--zero`. Operands: paths to resolve. |
| `realpath` | executable | Options: `-e`/`--canonicalize-existing`, `-m`/`--canonicalize-missing`, `-L`/`--logical`, `-P`/`--physical`, `-q`/`--quiet`, `-s`/`--strip`, `--no-symlinks`, `-z`/`--zero`, `--relative-to=DIR`, `--relative-base=DIR`. Operands: paths to resolve. |
| `rg` | executable | Options: `-A NUM`/`--after-context=NUM`, `-B NUM`/`--before-context=NUM`, `-C NUM`/`--context=NUM`, `-a`/`--text`, `-b`/`--byte-offset`, `-c`/`--count`, `--count-matches`, `-s`/`--case-sensitive`, `--color=WHEN`, `--column`, `--crlf`, `-d NUM`/`--max-depth=NUM`, `-e PATTERN`/`--regexp=PATTERN`, `-f PATTERNFILE`/`--file=PATTERNFILE`, `-F`/`--fixed-strings`, `--files`, `-l`/`--files-with-matches`, `--files-without-match`, `-L`/`--follow`, `-g GLOB`/`--glob=GLOB`, `--glob-case-insensitive`, `--iglob=GLOB`, `-H`/`--with-filename`, `-I`/`--no-filename`, `--heading`, `--no-heading`, `--hidden`, `-i`/`--ignore-case`, `--json`, `-m NUM`/`--max-count=NUM`, `-M NUM`/`--max-columns=NUM`, `--max-filesize=SIZE`, `-n`/`--line-number`, `-N`/`--no-line-number`, `--no-config`, `--no-ignore`, `--no-ignore-dot`, `--no-ignore-exclude`, `--no-ignore-files`, `--no-ignore-global`, `--no-ignore-parent`, `--no-ignore-vcs`, `--no-messages`, `--no-require-git`, `-0`/`--null`, `--null-data`, `--one-file-system`, `-o`/`--only-matching`, `-p`/`--pretty`, `-P`/`--pcre2`, `-q`/`--quiet`, `-r REPLACEMENT`/`--replace=REPLACEMENT`, `-S`/`--smart-case`, `--sort=SORTBY`, `--sortr=SORTBY`, `--stats`, `-t TYPE`/`--type=TYPE`, `-T TYPE`/`--type-not=TYPE`, `--type-list`, `--trim`, `-u`/`--unrestricted`, `-U`/`--multiline`, `--multiline-dotall`, `-v`/`--invert-match`, `--vimgrep`, `-w`/`--word-regexp`, `-x`/`--line-regexp`. Operands: a pattern (unless `-e`/`-f`), then files or directories to search. Unclassified while `RIPGREP_CONFIG_PATH` is non-empty unless `--no-config` is given. |
| `sed` | executable | Options: `-n`/`--quiet`, `--silent`. Operands: one script of the form `Np`, `N,Mp`, `$p` or `N,$p` (decimal `N`, `M`), then at most one file. One of `-n`, `--quiet` or `--silent` is required. |
| `sort` | executable | Options: `-b`/`--ignore-leading-blanks`, `-c`, `-C`, `-d`/`--dictionary-order`, `-f`/`--ignore-case`, `-g`/`--general-numeric-sort`, `-h`/`--human-numeric-sort`, `-i`/`--ignore-nonprinting`, `-k KEYDEF`/`--key=KEYDEF`, `-m`/`--merge`, `-M`/`--month-sort`, `-n`/`--numeric-sort`, `-r`/`--reverse`, `-R`/`--random-sort`, `-s`/`--stable`, `-S SIZE`/`--buffer-size=SIZE`, `-t SEP`/`--field-separator=SEP`, `-u`/`--unique`, `-V`/`--version-sort`, `-z`/`--zero-terminated`, `--sort=WORD`. Operands: files to read. |
| `stat` | executable | Options: `-L`/`--dereference`, `-c FORMAT`/`--format=FORMAT`, `--printf=FORMAT`, `-f`/`--file-system`, `-t`/`--terse`. Operands: files to describe. |
| `tail` | executable | Options: `-c NUM`/`--bytes=NUM`, `-n NUM`/`--lines=NUM`, `-q`/`--quiet`, `--silent`, `-v`/`--verbose`, `-NUM`. Operands: files to read. Operands starting with `+` are not accepted. |
| `tr` | executable | Options: `-c`/`--complement`, `-C`, `-d`/`--delete`, `-s`/`--squeeze-repeats`, `-t`/`--truncate-set1`. Operands: character sets (not files); reads standard input only. |
| `true` | shell builtin | Any words (ignored). |
| `uniq` | executable | Options: `-c`/`--count`, `-d`/`--repeated`, `-D`, `-f N`/`--skip-fields=N`, `-i`/`--ignore-case`, `-s N`/`--skip-chars=N`, `-u`/`--unique`. Operands: at most one input file (a second operand names an output file). |
| `wc` | executable | Options: `-c`/`--bytes`, `-l`/`--lines`, `-m`/`--chars`, `-w`/`--words`, `-L`/`--max-line-length`. Operands: files to read. |

<!-- known-read-only-commands:end -->

### Code mode, user shell and extensions

Nested code-mode `bash` calls use the same analysis, policies, prompts and
grants as ordinary calls. User `!` commands are never analyzed: they remain
fixed-allow and run through the selected backend. The standalone
`@kcosr/pi-sandbox-extension` package has no approvals and does not classify
commands.

The analyzer is created once at startup, only when the effective Bash policy has
a class policy. If it cannot be created, startup fails with
`Bash command analysis could not be initialized: <cause>`; it never falls back to
unclassified or direct execution.

### Known read-only diagnostics

`/sandbox policy` adds a `bash (known read-only)` row showing the class policy
and its class-scoped grant:

```text
SUBJECT                 EXECUTION  MODE   SESSION OPTION  ACTIVE GRANT
bash                    sandbox    deny   never           -
bash (known read-only)  sandbox    ask    offer           yes
```

`/sandbox policy bash` shows the class policy, the registry version and the
known command names, and states that classification does not change execution:

```text
Known read-only:   ask
  Approval:        session grant active
  Session option:  offer
  Active grant:    yes

Known read-only commands (registry version 1):
  Shell builtins: cd, echo, false, pwd, true
  Executables: basename, cat, cut, diff, dirname, du, find, grep, head, ls, nl, readlink, realpath, rg, sed, sort, stat, tail, tr, uniq, wc

Scope:
  ...
  Command classification selects only the approval policy; an approved command runs unchanged within the same boundary.
```

Without a class policy, `/sandbox policy` and `/sandbox policy bash` are
unchanged and show no class rows.

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

When the effective Bash policy has a `known_read_only` class policy, Bash
`tool_execution_intent` and `tool_denied` records also carry `command_class`
(`known_read_only` or `unclassified`) and `known_read_only_version`, the
positive registry version used for the decision. Both fields appear together,
only on those two Bash events, and are absent without a class policy.
`approval_source` keeps its existing values; a class-scoped grant reports
`session_grant`.

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
