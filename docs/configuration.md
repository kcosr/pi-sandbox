# Configuration and approvals

## Configuration ownership

Pi Sandbox always reads the `config_dir/config.toml` path compiled from the
distribution manifest; no CLI argument,
environment variable, user setting, or project file can redirect it. The
configuration contains a required absolute `models_file` path selected by the
administrator. Pi Sandbox loads that file as the complete model catalog and
disables Pi's internal model catalog.

The main configuration contains the global `pi`, `sandbox`, and
extension-specific scoped environment. The required `identity` table either
disables user resolution or selects the fixed administrator broker. Broker mode
may overlay an optional version 5 `config_dir/users.d/<uid>.toml` patch for
the calling UID, including scoped environment, selected model file, execution
backend, network mode, and any subset of model-tool policies. A missing
directory or matching file leaves the main configuration unchanged. See
[per-user environment and overrides](identity-broker.md).

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

Project-local files are untrusted content and cannot broaden the installed
policy. The only merge is an administrator-owned per-UID broker drop-in.

`PI_CODING_AGENT_DIR` remains supported for user state such as credentials,
sessions, settings, skills, themes, and logs. It never changes the administrative
configuration path or `models_file`.

Provider definitions and API-key resolution are documented separately in
[Models and authentication](models.md).

## Complete example

```toml
config_version = 5
models_file = "/etc/pi-sandbox/models.json"

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

[tools.grep]
mode = "allow"
session_grant = "never"

[tools.find]
mode = "allow"
session_grant = "never"

[tools.ls]
mode = "allow"
session_grant = "never"

[tools.write]
mode = "ask"
session_grant = "never"

[tools.edit]
mode = "ask"
session_grant = "never"

[tools.bash]
mode = "ask"
session_grant = "never"

[tools.git_clone]
mode = "ask"
session_grant = "never"

```

All seven built-in `[tools.<name>]` sections are required, as is one section for
every tool contributed by every selected extension. No policy may be present
for an unselected extension tool. User `!` shell is not configurable: it always
runs without an approval prompt through the selected backend. It is human-only
and is never advertised to the model. Setting `[tools.bash]` to `disabled`
therefore removes model Bash while preserving the user's `!` command.

These TOML sections are the complete global tool policy. A broker UID drop-in
may replace the complete execution backend and network mode and may atomically
replace individual complete policies, including setting
`git_clone` or another selected extension tool to `deny` or `disabled`. Per-UID environment values
never select an extension, add a tool, change a policy, or authorize a call.

`models_file` is also required and must name a normalized absolute file path.
The administrator may place catalogs elsewhere. In broker mode a root-managed
UID drop-in may replace it; no user environment, CLI argument, Pi setting, or
project file can do so. `--model` may select only a model present in the
effective file.

## Network modes

| Mode   | Tool and shell network authority                                            |
| ------ | --------------------------------------------------------------------------- |
| `none` | Private network namespace with connectable socket creation denied           |
| `host` | Complete host network namespace, including host loopback, LAN, and Internet |

`host` is deliberately unrestricted. Bubblewrap does not provide IP, port,
hostname, or destination filtering, and Pi Sandbox does not imply such filtering
when this mode is selected. There is no CLI or environment override. In broker
mode, an administrator-owned UID drop-in may replace the base network mode.
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
remove the requirement to state its policy. Per-UID broker drop-ins can replace
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
lifetime, execution backend, launch directory, fixed configuration path,
effective selected model file, identity mode, effective network mode, and
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
their normal request details. Managed API version 3 tools may provide a short,
single-line call summary that Pi Sandbox bounds and renders in the same tool
card. `git_clone` shows its repository locator. A standard Pi extension keeps
its own tool renderer, if supplied. The approval selector
therefore contains only `Allow <subject>?` and the configured choices. The
internal immutable snapshot and integrity fingerprint are not repeated in the
UI.

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

Pi SDK 0.84.3 does not expose live `user_shell` replacement progress without
using its stock operations, whose truncation path writes an artifact to host
temporary storage. Pi Sandbox intentionally returns one final bounded, sanitized
user-shell result instead. Model Bash retains ordinary tool update rendering;
both result paths remove ANSI escapes, carriage returns, and unsafe controls.
Model Bash defaults to a 120-second sandbox timeout and accepts an explicit
timeout greater than zero through 600 seconds. User `!` shell always uses the
fixed 120-second timeout and has no per-command override.

Either kind of shell command can read the ordinary host filesystem, write anywhere
inside the launch CWD, and write private temporary state. It cannot mutate the
rest of the host filesystem. Its network authority is the effective `network`
mode. Structured-tool policies do not intercept file or network operations
performed by Bash.
