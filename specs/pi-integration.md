# Pi integration and upgrade contract

This document is the authoritative behavioral contract for integrating Pi into
Pi Sandbox. Patch files describe how the contract is implemented against one
pinned release; this specification governs when an upstream upgrade requires
those patches to be reimplemented.

## Source pin

`pi-source.lock.json` records the only admitted upstream source:

| Field                  | Pinned value                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------- |
| Version                | `1.1.0`                                                                                |
| Tag                    | `v1.1.0`                                                                               |
| Commit                 | `abe508e1b89912adde45528136c3221eb69acdd7`                                             |
| Source archive         | `https://github.com/earendil-works/pi/releases/download/v1.1.0/pi-1.1.0-source.tar.gz` |
| Source archive SHA-256 | `63b17b48b855e36e64c5013523acd48131ffcfa90ae48fe2f3e6fa9fe3d0da32`                     |

The build may download that archive or accept the identical archive from a
local path. It must verify the SHA-256 digest before extraction. It extracts Pi
into temporary or ignored build storage and applies the ordered patch series
from `patches/pi`. Neither the upstream archive nor an extracted Pi worktree is
committed to this repository or distributed to installed hosts.

Moving any pinned field is an explicit Pi upgrade. A moving branch, version
range, package-manager resolution, target-host download, or unverified source
tree is not allowed. The integration targets the pinned Pi 1.x release only; it does not retain
pre-1.0 API or launch compatibility paths.

## Product boundary

The managed application's `--version` output and TUI header display the pinned
Pi version followed by the product identity, for example `1.1.0+ps.0.7.0` for
a clean checkout at product tag `v0.7.0`. Untagged Git builds append
`.dev.g<short-sha>` and modified builds append `.dirty`; source execution or
application builds without Git metadata use `.dev.source`. The full release
builder requires Git metadata for source provenance. Compute and embed Git
identity at build time, never during operational startup. Preserve Pi's internal
`VERSION` and all upstream update/changelog comparisons. Product package and
release versions remain independent from upstream and extension package
versions; see [versions and releases](../docs/releases.md).

The release contains one prebuilt Bun application named `pi-sandbox`. The Pi
Sandbox extension remains a separately maintained source module but is imported
by the private entry point and compiled into that executable. The extension is
not an adjacent runtime JavaScript file and is not loaded through user-facing
extension discovery.

The private entry point calls Pi's exported `main()` API and supplies the Pi
Sandbox factory through the inline extension-factory option. It must:

- always load exactly the Pi Sandbox extension;
- omit Pi's built-in extension factories;
- disable and reject user/project extension discovery and explicit extension
  arguments;
- disable automatic built-in MCP, codemode, tool-search, and llama factories and
  reject the MCP management CLI; only the forced factory may compose the
  exported MCP/code-mode factories under administrator policy;
- disable Pi's built-in tools and reject any option that restores them;
- reject Pi package install, remove, update, and configuration commands that
  could introduce executable code;
- admit managed host environment values only through the selected compiled
  extension's versioned declaration, never through Pi extension discovery;
- disable external session sharing through `/share`, omit it from command
  discovery and CLI help (including `PI_SHARE_VIEWER_URL`), and retain local `/export`;
- preserve skills, options that disable skills, and options that narrow the
  visible tool catalog; and
- fail closed before interactive startup if managed initialization fails.

No Bubblewrap, approval, tool, argument-filtering, configuration, or installer
policy belongs throughout upstream Pi. Those behaviors remain in Pi Sandbox
modules. The Pi patch series exposes only the generic integration seams that
the private entry point requires.

## Administrative configuration and models

The executable begins configuration resolution at the build-selected path,
normally:

```text
/etc/pi-sandbox/config.toml
```

Version-3 distribution manifests require a boolean `allow_config_override`.
With `false` (the default distribution), the path is fixed and the executable
rejects `--config`. With `true`, a leading `--config FILE` or `--config=FILE`
selects the TOML; relative paths resolve from the launch CWD. Pi Sandbox
consumes the option before Pi argument handling. Reject missing, repeated, and
misplaced flags. Invalid selected input must not fall back to the default.
Validation commands and diagnostics must use and report the selected path.
No environment variable, Pi setting, or automatic project discovery may enable
or redirect this selection. The strict configuration has a required normalized
absolute `models_file`; selecting a TOML does not alter model-path semantics,
service sockets, or the broker/collector's own configuration directories. In broker mode, a root-managed drop-in
selected by the kernel-authenticated account and its primary/supplementary groups may replace the model file,
execution backend, network mode, CWD write access, and complete invocation
permissions for a subset of model tools. The main TOML supplies the global scoped environment. An optional
user/group TOML drop-in may overlay that environment. No other field is
overridable.

The managed Pi model runtime must:

- read model definitions from the resolved `models_file`;
- expose no model that is present only in Pi's internal catalog;
- use no persistent or downloaded catalog as a fallback;
- retain the applicable Pi provider implementations needed by explicitly
  configured models; and
- fail startup when the administrative catalog is missing, unreadable,
  malformed, or semantically invalid.

The executable does not check that administrative files are owned by root or
have particular modes. Deployment is responsible for installing them with the
intended ownership and permissions.

## User state

Pi's normal `PI_CODING_AGENT_DIR` environment variable remains supported. It
selects user state, including credentials, sessions, settings, skills, themes,
logs, and caches. It must not affect:

- `/etc/pi-sandbox/config.toml`;
- the resolved `models_file`;
- inclusion of Pi's internal model catalog;
- extension loading; or
- tool implementations.

Interactive authentication and retained credentials therefore remain
per-user, while the administrator controls the available model definitions.

Schema 9 expands bare `~` and a leading `~/` in main-policy hidden paths and
configured scoped environment values, including user/group values after the
broker merge. Resolve the invoking effective user's home from the OS account
database once at operational startup, before applying any configured environment
or constructing executors. Ambient or configured `HOME` and CWD must not affect
this resolution. Preserve nonmatching environment strings literally and recheck
expanded bounds and hidden-path restrictions. Installation validation must not
expand against the installer's account. This behavior belongs to Pi Sandbox,
not the upstream Pi patch series; it does not extend to model/configuration/
installation paths, arbitrary extension settings, inherited environment, or
compiled fixed extension values.

The main schema-10 configuration requires `[sessions].retention_days`, an integer
from `0` through `36500`, defaulted to `365` in packaged TOML. User/group rules
cannot override it. Zero disables both cleanup and last-use timestamp updates.
Otherwise, use session-file modification time as the retention clock, refreshing
the selected session at operational startup and each logical session activation
or resume, even when no message is appended.

Before starting an interface, Pi Sandbox awaits a best-effort sweep when the
selected storage root has not been checked within 24 hours or retention policy
has changed. Default storage is the agent directory's `sessions` tree with one
workspace-directory level; explicit custom session storage is flat. Never
perform an arbitrary recursive scan or load transcript bodies. Only expired
regular `.jsonl` files are opened, with at most 4096 bytes read to validate a
complete first-line Pi session header. Skip malformed or oversized headers,
symlink paths within the store, and the currently selected session. Recheck
identity and age before deletion; tolerate deletion races and other failures.

Scheduling records live under the selected agent directory at
`pi-sandbox/retention/<root-and-layout-hash>.json`; write the attempt time and
retention value before the sweep. Do not add an active-session registry or
cross-process lock. Concurrent sweeps and a rare concurrent-resume race are
accepted best-effort behavior. Only an interactive sweep lasting more than
about one second displays `Checking for old sessions…`, before the TUI starts;
other modes and cleanup errors remain silent. System audit-log retention is
independent and remains host-owned.

## User and group resolution

The optional identity broker is a separate static native executable, activated
per socket connection. It obtains UID from Linux `SO_PEERCRED` and invokes the
fixed `/usr/bin/getent` host NSS resolver to identify the account and its primary
and supplementary groups. The compiled configuration directory is its process
argument. It reads optional protected `users.d/*.toml` and `groups.d/*.toml`
rules, selecting exactly one `user`/`uid` or `group`/`gid` per file. Filenames are
labels. Names and numeric selectors have identical precedence.

The protocol uses newline-delimited JSON version 6 and operation
`resolve-identity`, with no caller-claimed identity. The client keeps its write
side open; the broker responds after reading the newline. Successful responses
contain only one combined matching environment/override patch. Missing rule
directories or no matching rules return an empty patch. The socket remains
`/run/pi-sandbox-identity/broker.sock` and cannot be redirected by policy.

Combine matching explicit permissions before overlaying defaults. Complete tool
pairs order as `disabled/never` < `deny/never` < `ask/never` < `ask/offer` <
`allow/never`; `host` wins for networking and `true` for CWD writability.
Different explicit backend/model values or values of the same scoped environment
key fail resolution. User rules have no extra precedence. Logging flags remain
parent-only. Revalidate the complete effective configuration after the merge.
Environment entries never select extensions, enable tools, or grant approval.

Host lookups are bounded to four seconds, the client deadline is ten seconds,
and the service lifetime is fifteen seconds. Local accounts and SSSD via local
sockets are supported; direct network LDAP is outside the service network
boundary. Membership is a startup snapshot subject to host account caching.
Lookup failure must not silently omit membership or matching rules.

The effective model catalog is loaded with the `pi` scope applied to the
trusted host process. The `sandbox` scope is added to Bubblewrap's cleared
environment or overlaid on the inherited environment of direct built-in
commands. Each `extensions.<id>` scope is admitted only for a selected
compiled extension and names that extension declares; Pi-scoped and other
extension-scoped values are excluded from its executor. Broker failures,
invalid matching drop-ins, invalid responses or scoped environments, and
invalid effective catalogs abort startup. Missing drop-ins do not. Disabled
broker mode skips user/group lookup but still applies the main configuration's
global scoped environment.

## Required Pi patch behavior

Keep the patch series as small and generic as practical. Against Pi 1.1.0 it
provides these seams:

1. `main()` accepts a caller-provided model-runtime factory and consistently
   uses it for interactive startup and supported authentication paths.
2. Model-runtime construction can exclude the internal provider/model catalog
   for every model type, including chat, image, and classifier models, without
   preventing explicitly configured providers from using Pi's trusted provider
   implementations. Refresh and provider recomposition must not restore excluded
   providers or fall back to their built-in catalogs after errors.
3. The managed interactive distribution rejects `/share` without exporting
   session content or invoking external sharing providers. It does not advertise
   that command; local `/export` remains available.

4. `main()` and the session runtime accept a generic synchronous workspace
   admission hook. It runs for initial session selection and every runtime
   recreation before target settings, instructions, or resources load. Resume and
   import validate before outgoing teardown; reload validates before resource
   refresh. Pi Sandbox supplies an exact canonical-launch-CWD check. The policy,
   executor, and workspace cannot be replaced through session RPC.
5. RPC replacement handlers rely on the runtime's single rebind callback for
   new/resume/fork/clone. They must not bind a replacement twice. Every genuine
   runtime gets a fresh forced extension instance; shutdown ends audit state and
   clears approval grants, while the process-owned executor stays available.
   The managed executor starts and probes through `beforeInterface`; each
   session-start hook also awaits its readiness before any managed tools become
   available. Metadata and invalid-CLI exits do not start a sandbox. Normal quit awaits the
   process-owned executor, managed host runners, and audit client cleanup from
   the session-shutdown hook, before Pi calls `process.exit`. The outer entry
   point uses that same idempotent cleanup if Pi returns or throws.
6. `main()` exposes a generic asynchronous `beforeRun` hook. After session
   selection and metadata/authentication exits, it passes the resolved mode,
   session manager, and optional resolved custom session directory and awaits
   completion before reading piped stdin, initializing themes, or starting any
   interface. Preserve custom storage selected through CLI, environment, or
   settings even with `--no-session`. Patch
   `0004-session-startup-maintenance.patch` supplies this seam; retention policy,
   scanning, scheduling, and progress output remain in Pi Sandbox.
7. The same patch supplies `beforeInterface`, an awaited final initialization
   hook after diagnostics, missing-model and invalid-benchmark exits and before
   catalog refresh or interface dispatch. Pi Sandbox starts and probes its lazy
   process-owned executor here. Rejection propagates to the entry point for
   cleanup; no interface or model request starts with an unavailable backend.
   Help, version, model listing, authentication and invalid CLI paths do not
   invoke this hook.
8. `0006-graceful-shutdown-status.patch` preserves a nonzero `process.exitCode`
   on normal RPC or interactive quit. Explicit signal status is unchanged.
   Managed cleanup sets failure status and reports underlying errors, including
   the retained VM-state path, before Pi reports an extension shutdown error.
   Cleanup still attempts and awaits every owned resource.
9. `0007-application-version-display.patch` accepts an optional `displayVersion`
   in `main()` and interactive-mode options. Use it only for CLI version output
   and the TUI header, falling back to Pi's own version when it is absent. The
   managed entry point supplies its build identity; ordinary Pi behavior and
   Pi's internal version remain unchanged.

Pi 1.0's resource loader separates built-in factories from ordinary inline
factories. The forced `--no-extensions` flag disables the built-in factories and
user/project discovery while retaining the mandatory Pi Sandbox inline factory.
No separate `includeBuiltInExtensions` patch or invocation option is needed.

Tests carried in the patch series must prove configured-only model exposure,
absence of built-in fallback after configuration failure, and use of the
injected runtime by every retained entry path, and rejection of external session
sharing without accessing session content. They also prove that disabling
extensions keeps the mandatory inline factory while omitting built-in and
discovered factories. Pi Sandbox tests separately prove the forced
private-entry-point policy.

Startup-hook tests must prove the awaited ordering for TUI, print, JSON, and
RPC, before stdin consumption and theme initialization, as well as the absence
of maintenance for metadata and authentication exits. Cover selected-session
access and effective custom session storage without adding cleanup logic to Pi.

Do not solve upstream merge conflicts by adding compatibility aliases or by
supporting both managed and obsolete launch shapes in Pi Sandbox. Reimplement
the behavioral seams against the new Pi structure, update focused upstream
tests, and remove patch hunks that are no longer needed.

## Upgrade procedure

To upgrade Pi:

1. Select a stable upstream release and record its exact version, tag, commit,
   official source-archive URL, and SHA-256 in `pi-source.lock.json`.
2. Extract the verified archive into disposable build storage.
3. Apply the existing patch series. If it does not apply cleanly, inspect the
   new upstream implementation and reimplement this specification rather than
   preserving obsolete code structure.
4. Build Pi and check the production adapter types against its patched declarations,
   including option-key coverage, nested options, and callback compatibility.
   Negative controls must reject removed options and incompatible signatures.
   Run the focused Pi patch tests and relevant upstream tests offline.
5. Build the private Bun entry point together with Pi and the Pi Sandbox
   extension.
6. Run Pi Sandbox unit, integration, direct-executor, real-Bubblewrap, package,
   install, and upgrade tests for applicable target platforms.
7. Inspect the final release archive for the documented version, platform,
   static assets, defaults, installer, and source commit. Generate and publish
   its checksum from the final release commit.

An upgrade is incomplete if the executable exposes an internal model, accepts
another extension, restores a stock tool implementation, redirects
administrative configuration through user state, or requires installed hosts to
download or build Pi.

## Installation contract

The Linux release installs one application directory at
`/usr/libexec/pi-sandbox`, a `/usr/bin/pi-sandbox` symlink, and identity-broker
systemd unit symlinks. The macOS release installs the application at
`/usr/local/libexec/pi-sandbox` with a `/usr/local/bin/pi-sandbox` symlink and
omits the Linux-only broker. There are no wrapper, runtime-download, or
generation layers.

The root-run installation helper installs code and assets on every install. On
first installation it creates `/etc/pi-sandbox/config.toml` and the packaged
default model file. On ordinary upgrades it preserves `/etc/pi-sandbox` and
validates the existing administrative inputs with the new executable. An
explicit `--replace-config` operation validates packaged defaults, backs up the
active files, and replaces them atomically.

The installer never creates, replaces, backs up, or removes
`/etc/pi-sandbox/users.d`, `/etc/pi-sandbox/groups.d`, or their contents, and does not enable or start the
broker socket.

Pi Sandbox does not produce an RPM. Site administrators may wrap the release
archive and these semantics in their own package-management system.

## Sandbox process lifetime

Bubblewrap process lifetime is configured independently of Pi tool selection.
The managed worker defaults to serial per-command cleanup; optional `sandbox` lifetime
preserves descendants across calls and logical Pi sessions and admits up to four
concurrent commands, with at most 64 outstanding requests. Keep same-path
write/edit serialization across whole operations. An active failure interrupts
affected peers and completes namespace cleanup before queued work starts;
queued cancellation affects only that request. Result acceptance and terminal
retirement must not let delayed frames invalidate newly admitted commands.
Qualify both the managed application and ordinary Pi extension. Match the pinned Pi
version's post-exit idle-drain behavior, including allowing continued output to
defer completion; do not introduce a separate absolute drain deadline. Pi 1.1.0
uses a 100 ms idle timer restarted by each chunk. Existing command timeout,
output limits, cancellation and sandbox shutdown remain authoritative. This
behavior lives in the managed worker and requires no upstream Pi patch.

## CWD filesystem access

Administrative configuration requires `[filesystem].cwd_writable`, with `true`
in packaged defaults. Root-managed user/group rules may replace that setting under
`[overrides.filesystem]`. Effective direct execution requires `true`.

The Bubblewrap backend always creates an explicit same-path CWD bind after its
private mounts: writable with `--bind`, read-only with `--ro-bind`. This preserves
visibility for `/tmp`-based workspaces independently of write permission and does
not by itself change host visibility. Schema 9 also requires
`[filesystem].hidden_paths` (empty by default), a main-policy-only list of paths to
canonical directories or regular files. Directories use private read-only tmpfs
masks; files use separate empty inputs to `--ro-bind-data`. Both retain the
configured name while masking original contents, without persistent host
placeholders or host-file mutations. Silently skip missing targets at worker
startup; paths created later on the host may be visible until restart unless
another mask covers them. Reject permission errors, non-directory ancestors,
special files, and symlink components, including dangling links and symlink
ancestors of missing targets. Hidden ancestors precede
the CWD restore; explicit hidden descendants follow it. Broker filesystem overrides
change only `cwd_writable` and cannot clear these masks. Effective direct execution
requires empty hidden paths. Host Pi context/session loading remains outside the
tool namespace. Private temporary/runtime
storage remains writable. Read-only CWD exactly `/tmp` is rejected because its
bind would mask private `/tmp`. Existing root and private-system-path overlap
rejections remain enforced. The setting applies to built-ins and user shell;
managed host tools retain their declared host authority.

## Managed MCP and code-mode seams

Patch `0005-managed-mcp-and-codemode.patch` extends the exported factories with
policy-neutral composition options. The main configuration, account macros,
credentials, tool policy, grants, audit records, and invocation concurrency stay
in Pi Sandbox.

The MCP factory accepts an injected connection configuration and transport factory,
a synchronous whole-catalog adapter with original server/tool provenance, and
connection-state callbacks. It adapts every complete catalog before publishing
any definitions, and withdraws definitions before reconnect or shutdown. Pi
Sandbox validates the catalog and installs its wrappers before publication.
Managed connections prepare discovery before approval and never silently
reconnect or replay `tools/call` after approval, including HTTP session-expired
responses. Disconnected servers may reconnect on a subsequent prompt. A catalog
refresh failure withdraws the server instead of preserving an unverified catalog.

A restricted management option reuses the stock MCP menu for admitted servers.
An awaited callback validates and saves enabled/exposure preferences before runtime
changes; failures and late callbacks cannot mutate a replacement session. It offers
only approved exposure choices and omits connection details, raw errors, project
overrides, and authentication actions. The managed adapter persists only presentation
preferences from user `mcp.json`; unknown servers and connection fields are inert.

Explicit options disable extension-registered servers,
automatic OAuth and provider authentication, raw server logs, resources and
resource templates, roots, and other non-tool protocol capabilities. HTTP query
parameters survive every POST, GET, and DELETE. JSON/error bodies are bounded as
they are consumed, matching SSE message bounds. Managed setup/catalog refresh
have an absolute 30-second deadline; lists have at most 64 pages, 1024 tools, and
8 MiB. Progress does not extend invocation deadlines. Stdio process-group
ownership outlives the group leader, and its remaining descendants are killed
when the leader exits or the transport closes.

The code-mode factory accepts generic execution limits, registers one active
script per managed instance, and aborts/awaits that script on session shutdown.
Pi Sandbox keeps code mode inactive by default, honors Pi's merged `defaultTools`
and `codemode.mode` settings, and applies CLI inclusion/exclusion ceilings to
initial activation and later MCP autoactivation. The administrator flag controls
registration. CLI modifier-only `--tools` lists adjust the managed defaults;
plain lists replace them. Final subtractive modifiers, explicit exclusions, and
`--no-tools` remain managed availability ceilings even for MCP autoactivation and
nested calls. Additions never broaden the effective TOML. Plain allowlists and
exclusions support `*` patterns; modifier entries use exact names. `--no-mcp`
suppresses managed connections as well as the upstream built-in factory.
Preserve stock `model-only` exposure to prevent recursive code-mode
calls. A fixed 3000-token declaration budget and omitted `models` bridge remain
managed constraints. The runtime caps source bytes, deadline, total and
concurrent bridge calls (including discovery helpers), and accumulated UTF-8
output bytes. Each serialized nested reply (including errors) and store-write
journal has the same byte ceiling, independently of aggregate visible output.
A source pragma may only shorten the administrator deadline.
Normalized tool-name collisions are rejected. Nested calls still use
`ctx.executeTool`, including the normal permission pipeline; the VM provides no
host JavaScript APIs. Script completion waits for canceled nested operations to
finish their local cleanup. MCP and code-mode output can be kept inline without
writing host temporary files inaccessible to sandbox tools.

Offline patch tests exercise factory composition, raw provenance and atomic
catalog rejection, tools-only initialization, no implicit authentication or
request replay, HTTP URL/query preservation and bounded body reads, VM limits,
absence of host APIs, nested cleanup ordering, and inline-only result handling.
These tests run during the release build alongside the existing integration
seams. Keep the QuickJS WASM asset and worker entry in the compiled release.
The private Bun build must resolve compiled package exports rather than the
upstream development tsconfig's source aliases. Runtime setup and the managed
factory must share one compiled Pi configuration module so the registered
embedded-WASM path is visible to code mode. Check the bundle metadata for that
single runtime and its embedded QuickJS asset; the packaged smoke test must
execute a real script. Disable Bun's project `bunfig.toml` and `.env` autoload
in the compiled application; project files cannot inject startup environment.
