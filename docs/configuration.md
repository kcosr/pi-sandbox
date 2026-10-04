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
compiled tools, the root runtime check, and the build-selected Bubblewrap
executable still apply. Identity broker and audit service sockets and their
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

The required `execution` table selects `bubblewrap` or `direct`. Bubblewrap is
available only on Linux. Direct execution is available on Linux and macOS and
runs approved built-in operations with the invoking user's ordinary host
filesystem and process authority. It is an explicit operating mode, never a
fallback after a Bubblewrap failure. macOS requires `identity.mode = disabled`.

The required `network` table selects `none` or `host` for built-in tools and
shell commands. Bubblewrap supports both. Direct execution requires `host` so a
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

## Complete example

```toml
config_version = 7
models_file = "/etc/pi-sandbox/models.json"

[audit]
enabled = false
facility = "local0"

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

These TOML sections are the complete global tool policy. A broker user/group rule
may replace the complete execution backend and network mode and may atomically
replace individual complete policies, including setting
`git_clone` or another selected extension tool to `deny` or `disabled`. User/group environment values
never select an extension, add a tool, change a policy, or authorize a call.

`models_file` is also required and must name a normalized absolute file path.
The administrator may place catalogs elsewhere. In broker mode a root-managed
user/group rule may replace it; no user environment, CLI argument, Pi setting, or
project file can do so. `--model` may select only a model present in the
effective file.

## Launch directory access

Configuration schema 7 requires both keys in `[filesystem]`:

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
host directories from the sandboxed tools' filesystem view.

A root-managed user/group rule may override this setting with
`[overrides.filesystem] cwd_writable = false`. Omission inherits the parent
value. The final backend/filesystem combination is validated after overrides;
switching a read-only base to direct execution also requires overriding
`cwd_writable` to `true`.

### Hidden directories

`hidden_paths` is an explicit array of unique, normalized absolute directory
paths. The default empty array preserves the ordinary read-only host view.
Every entry must exist and be canonical at worker startup; symlinks in the
entry or any ancestor, missing paths, and regular files are rejected. To hide a
file, hide its containing directory. `/`, `/tmp`, and paths overlapping `/proc`,
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
directory contents are hidden. An additional entry inside `run-a` hides that
subdirectory even after the workspace is restored. Redundant nested entries
are reduced deterministically without losing these interior masks. Mask
directories remain visible as empty directories (or the private ancestor
skeleton leading to CWD), and cannot be written or made writable by tools.

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

## Network modes

| Mode   | Tool and shell network authority                                            |
| ------ | --------------------------------------------------------------------------- |
| `none` | Private network namespace with connectable socket creation denied           |
| `host` | Complete host network namespace, including host loopback, LAN, and Internet |

`host` is deliberately unrestricted. Bubblewrap does not provide IP, port,
hostname, or destination filtering, and Pi Sandbox does not imply such filtering
when this mode is selected. There is no dedicated network CLI or environment
override; the selected TOML supplies the mode. In broker
mode, an administrator-owned user/group rule may replace the base network mode.
Provider traffic from host-side Pi is unaffected by either setting.

`direct` requires `host`. This requirement is checked both for the base TOML
and after broker execution and network overrides are applied.

Managed host tools are unaffected by this table: they deliberately use the
invoking user's host network namespace and ordinary host controls.

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
```

`/sandbox` reports whether the selected backend is initialized, its process
lifetime, execution backend, launch directory, selected configuration path,
effective selected model file, identity mode, effective network mode, CWD access, and
user-state directory. `/sandbox mounts` reports the semantic Bubblewrap mount
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
supplied. The approval selector therefore contains only `Allow <subject>?` and
the configured choices. The internal immutable snapshot and integrity
fingerprint are not repeated in the UI.

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
