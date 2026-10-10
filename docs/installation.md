# Installation and operation

## Requirements

Installed hosts require x86-64 or arm64 Linux, or x86-64 or arm64 macOS.

Linux Bubblewrap mode requires working unprivileged user namespaces and either
the build-selected system Bubblewrap executable or the release's verified
bundled Bubblewrap executable. Linux direct mode does not use Bubblewrap. Both Linux modes require
`fd` (or Debian's `fdfind`), Ripgrep (`rg`), `file`, Bash, a POSIX `/bin/sh`, and
the fixed GNU utilities used by typed tools.

The build and installer validate required Bubblewrap options, including
`--remount-ro` for directory masks and `--ro-bind-data` for empty file masks.

macOS supports direct mode only and requires Homebrew `coreutils`, `findutils`,
`grep`, `gawk`, `fd`, and `ripgrep`, plus system Bash, `sh`, and `file`. The
runtime resolves the Homebrew prefix for Apple silicon or Intel and fails
closed if a GNU command is missing. A macOS release build additionally requires
Homebrew GNU tar (`gtar`) for reproducible archives.

Configured home-directory expansion requires `/usr/bin/getent` on Linux or
the system `/usr/bin/dscacheutil` on macOS. The runtime queries the effective
user's OS account with a five-second deadline and a cleared environment; it
does not use `HOME` as a fallback. This lookup runs only when a configured
hidden path or scoped environment value needs expansion. A missing command,
missing account, invalid home, or lookup failure stops operational startup.

Selected managed extensions add conditional absolute-executable requirements.
The Git extension requires `/usr/bin/git`. Startup validates the requirements
for every selected managed extension; separately maintained executables and
their configuration remain deployment inputs.

The distributed application and optional Linux static identity and event-collector
services are prebuilt.
An installed host does not need Bun, Node.js, Rust, a package source tree, a
compiler, network access, or Pi source. A release without the Git extension
selected does not require Git. Pi Sandbox does not require QEMU,
Gondolin, Docker, or a persistent privileged daemon; the optional root broker
is systemd socket activated per connection on Linux. Broker identity is not
supported or packaged on macOS; macOS configuration must set
`identity.mode = "disabled"` and `[audit].enabled = false`.

## Release archive and installed layout

Each platform-specific release archive is complete and may be copied to an offline host. It
contains the executable, its required adjacent static assets, administrative
defaults, and the installation helper. Installation uses one application
directory rather than wrapper generations:

```text
/usr/bin/pi-sandbox -> /usr/libexec/pi-sandbox/pi-sandbox

/usr/libexec/pi-sandbox/
  pi-sandbox
  pi-sandbox-identity-broker
  pi-sandbox-audit-collector
  bwrap                         # bundled-provider releases only
  package.json
  sbom.cdx.json
  theme/
  assets/
  export-html/
  photon_rs_bg.wasm
  native/linux/prebuilds/<platform>/
    linux-platform-x11.node
  defaults/
    config.toml
    models.json
  systemd/
    pi-sandbox-identity-broker.socket
    pi-sandbox-identity-broker@.service
    pi-sandbox-audit.socket
    pi-sandbox-audit@.service
  licenses/
    LICENSE
    identity-broker/
      THIRD-PARTY-NOTICES.md
      <vendored package license texts>
    bubblewrap/                 # bundled-provider releases only
      LICENSE

/usr/lib/systemd/system/
  pi-sandbox-identity-broker.socket -> packaged unit
  pi-sandbox-identity-broker@.service -> packaged unit
  pi-sandbox-audit.socket -> packaged unit
  pi-sandbox-audit@.service -> packaged unit

/etc/pi-sandbox/
  config.toml
  models.json
```

These are the default paths. The build-selected distribution manifest may set
different absolute root-owned config, libexec, launcher, identity-socket, and
Linux service-unit paths. It also selects a system or bundled Bubblewrap
provider. Those choices are compiled into the application and
rendered into its installer, uninstaller, systemd units, and release manifest.

The default macOS layout omits both Rust services, their licenses, and systemd units:

```text
/usr/local/bin/pi-sandbox -> /usr/local/libexec/pi-sandbox/pi-sandbox

/usr/local/libexec/pi-sandbox/
  pi-sandbox
  package.json
  sbom.cdx.json
  theme/
  assets/
  export-html/
  photon_rs_bg.wasm
  native/darwin/prebuilds/<platform>/
    darwin-platform.node
  defaults/
  licenses/

/etc/pi-sandbox/
  config.toml
  models.json
```

Broker mode may additionally read
`/etc/pi-sandbox/users.d/*.toml` and `/etc/pi-sandbox/groups.d/*.toml`. The optional live directories and their
root-owned mode-0600 drop-ins are deliberately absent from the release and are
never created, replaced, backed up, or removed by the installer or uninstaller.

The executable embeds Pi's image-resize and codemode workers and its QuickJS
runtime data. Code mode is disabled in packaged defaults and enabled only by
main-policy `[codemode].enabled`. MCP servers and their dependencies are installed
by the administrator; the application performs no package downloads. The
adjacent native helper matches the release platform and architecture.

Only assets actually required by the pinned Pi build need to be present. The
release process inspects the archive against this documented layout and records
its checksums before distribution. The release manifest also records the
compiled extension kinds, identifiers, versions, tool names, manifest and entrypoint
digests, optional repository/revision provenance, private bundle digest, and
the selected Bubblewrap provider, runtime path, version, and binary digest.

`/etc/pi-sandbox/config.toml` is the default policy entry point. Managed builds
reject CLI policy selection. A distribution built with `allow_config_override = true`
accepts a leading `--config FILE`; the selected TOML then supplies the required
absolute `models_file`. See [configuration modes](configuration.md). Pi Sandbox performs no
root-ownership or file-mode checks; deployment tooling is responsible for
ownership and permissions.

## Building a release

Release builds use Node.js 24 or newer with `NODE_ENV` unset. Linux release
builds also use Rust/Cargo 1.85 or newer; Rust dependencies are pinned and
vendored so the broker builds offline:

```sh
env -u NODE_ENV npm ci
env -u NODE_ENV npm run verify:release
```

One strict TOML distribution manifest selects all extension manifests and the
platform installation layouts. For example:

```sh
env -u NODE_ENV npm run verify:release -- \
  --distribution /path/to/company/pi-sandbox-distribution.toml
```

```toml
version = 3
allow_config_override = false
extension_manifests = [
  "/path/to/pi-sandbox-extension.json",
  "/path/to/private-extension/pi-sandbox-extension.json",
]

[platforms.linux]
config_dir = "/etc/pi-sandbox"
libexec_dir = "/usr/libexec/pi-sandbox"
launcher_path = "/usr/bin/pi-sandbox"
service_dir = "/usr/lib/systemd/system"
identity_socket_path = "/run/pi-sandbox-identity/broker.sock"
audit_socket_path = "/run/pi-sandbox-audit/collector.sock"

[platforms.linux.bubblewrap]
mode = "system"
path = "/usr/bin/bwrap"

[platforms.darwin]
config_dir = "/etc/pi-sandbox"
libexec_dir = "/usr/local/libexec/pi-sandbox"
launcher_path = "/usr/local/bin/pi-sandbox"
identity_socket_path = "/run/pi-sandbox-identity/broker.sock"
audit_socket_path = "/run/pi-sandbox-audit/collector.sock"
```

Linux may instead package a prebuilt Bubblewrap binary:

```toml
[platforms.linux.bubblewrap]
mode = "bundled"
binary = "./build-inputs/bwrap-linux-x64"
version = "0.11.2"
sha256 = "<lowercase SHA-256>"
license_file = "./build-inputs/bubblewrap-COPYING"
```

Build-input paths resolve relative to the distribution manifest. The release
builder requires regular files, verifies the binary digest, Linux architecture,
reported version, and required command-line options, then installs it at
`libexec_dir/bwrap` with mode `0755`. The license is packaged beside the other
third-party notices. System mode packages no Bubblewrap binary and leaves the
selected absolute path unmanaged.

Each strict JSON extension manifest has `"manifestVersion": 1`, kind
`"managed"` or `"pi-tool"`, API version 3, a lowercase hyphenated identifier,
semantic version, relative entrypoint, exact tool-name list, and optional
repository/revision provenance. A `pi-tool` entrypoint is a standard Pi
extension factory; only tool registration and `pi.exec` are exposed during
factory initialization. A managed entrypoint uses the Pi Sandbox SDK. The build
resolves and statically imports every entrypoint and records hashes. It does not
create runtime search paths or copy extension source. The default distribution
selects Git; a private distribution can live beside private extensions and
select Git plus those manifests.

For a standard Pi extension whose default export is an ordinary extension
factory, use:

```json
{
  "manifestVersion": 1,
  "kind": "pi-tool",
  "apiVersion": 3,
  "id": "example-tools",
  "version": "1.0.0",
  "entrypoint": "./index.ts",
  "tools": ["example_lookup"]
}
```

Then select it with an empty `[extensions.example-tools]` table and provide a
complete `[tools.example_lookup]` policy. Factories that register commands,
event handlers, renderers, flags, or other non-tool features are rejected.

The version-3 distribution manifest requires `allow_config_override = false`
for managed installations or `true` to expose the runtime `--config FILE` prefix.
This is compiled into the executable and recorded in the release manifest.
Older distribution manifest versions are rejected. The switch does not change
installer generation or installation paths: the installer still manages the
compiled layout and packaged defaults. A local test may extract the payload
and run its executable directly with `--config`, without installing services.

The distribution manifest also sets `config_dir`, `libexec_dir`,
`launcher_path`, `identity_socket_path`, `audit_socket_path`, and, on Linux, `service_dir` for each
platform, plus the Linux Bubblewrap provider. These installation paths are
normalized absolute paths fixed at build time. Only the application policy path
can be selected at launch, when the build enables `--config`. A
packaged default config must point `models_file` at that layout's
`config_dir/models.json`.

The build produces a native archive for its current Linux or macOS architecture.
It downloads, or accepts a locally supplied copy of, the official Pi
1.1.0 source archive pinned in `pi-source.lock.json`. It verifies the recorded
SHA-256 digest, extracts the source into temporary or ignored build storage,
applies the small patch series in `patches/pi`, compiles Pi plus the separate Pi
Sandbox extension and selected modules into the Bun application, and
builds the broker as a static native executable on Linux. Pi still loads only the single
forced Pi Sandbox extension factory. The extracted Pi worktree and external
extension sources are not included in the release archive.

See [Pi integration and upgrade contract](../specs/pi-integration.md) for the
authoritative upstream contract.

## Installing and upgrading

Extract the release archive and run its helper as root:

```sh
sudo ./install.sh
```

Root authority is for installation only. Launch `pi-sandbox` from the intended
working directory as the unprivileged user whose host permissions and state
should apply. Interactive startup with effective UID `0` is rejected without a
configuration override. The installer may invoke the executable's
non-interactive configuration validation commands as root; those commands do
not start Pi or an execution backend.

The default distribution installs under `/usr` on Linux and `/usr/local` on
macOS, with `/etc/pi-sandbox` for administrative configuration. A custom
distribution uses its compiled paths. The macOS installer validates
the native direct-mode config and GNU prerequisites and never installs broker
or service-manager files.

The installer serializes concurrent updates with
`/usr/libexec/.pi-sandbox.install.lock`. If an interrupted installation leaves
that directory behind, first verify that no installer is running, then remove
the lock directory and retry.

The helper refuses a live system installation when the platform prerequisites
described above are absent or not executable. Selected extension prerequisites are checked when
the effective configuration is admitted. Neither path installs operating-system
packages; install those dependencies first. Staged `DESTDIR` installation
skips host checks because dependency resolution belongs to the target image.

The installer installs or upgrades both executables, packaged assets, and
managed systemd unit symlinks. It does not enable or start the broker socket. On the
first installation it also copies the packaged defaults to
`/etc/pi-sandbox/config.toml` and `/etc/pi-sandbox/models.json`. On an ordinary
upgrade it preserves all existing files under `/etc/pi-sandbox` and validates
them with the new executable before completing the installation.

After a successful operation, the installer prints both executables, the
launcher and unit symlinks, runtime support directory, live administrative
files, and any backups it created. Configuration entries are labeled as
installed, replaced, or preserved. It separately identifies `users.d` and `groups.d` as
optional administrator-managed directories that it did not create or alter.

To intentionally deploy the package's administrative configuration as well as
its code, use:

```sh
sudo ./install.sh --replace-config
```

`--replace-config` validates the packaged files, makes recoverable backups of
the active configuration and model files, and then replaces them atomically.
There is no implicit configuration replacement. This supports both complete
archive deployments and systems where Salt or another configuration manager
owns `/etc/pi-sandbox`.

The installed configuration uses `config_version = 10` and must include the
`[audit]`, `[sessions]`, `[codemode]`, `[mcp.servers]`, `[execution]`, `[filesystem]`, and `[extensions]` tables, an `audit` boolean on every
base tool policy, explicit `filesystem.hidden_paths` (empty by default), and explicit `[environment.pi]`,
`[environment.sandbox]`, and `[environment.extensions]` tables, even when the
environment tables are empty. Set `execution.backend = "bubblewrap"` on Linux
for containment, or `execution.backend = "direct"` on Linux/macOS for
policy-gated execution in the user's host security context. Direct mode also
requires `network.mode = "host"`, `filesystem.cwd_writable = true`, and
`filesystem.hidden_paths = []`; macOS
requires disabled identity. If a
preserved site configuration does not satisfy the current schema, update the
site-managed TOML first or use `--replace-config` to install the packaged
defaults.

`[sessions] retention_days = 365` is the packaged conversation-retention
default. The required value is an integer from `0` to `36500`; use `0` to disable
cleanup and last-use timestamp updates. This policy belongs to the main TOML
and is not accepted in user/group overrides. Older configurations are not
automatically migrated. Schema 9 adds home-directory expansion in hidden paths
and configured scoped environment values; review values equal to `~` or
starting with `~/` before updating the version. Configurations older than
schema 8 also need the required session policy. Alternatively, explicitly
replace configuration with the packaged defaults.

Installer validation checks home-relative syntax without expanding it to the
root installer's home or requiring per-user hidden paths to exist. Operational
startup expands against the invoking effective user's OS account home and
validates the resulting paths, silently skipping missing hidden targets.
Model and installation paths remain absolute.

When the optional identity broker is enabled, `users.d/*.toml` and `groups.d/*.toml` may overlay
scoped environment and supply model, execution, network, filesystem, and complete
tool-policy overrides for the account and its primary/supplementary groups. Matching
explicit permissions combine using least restrictive wins before overlaying defaults. Global/default values belong in the main
`config.toml`; there is no separate defaults or aggregate users file. If no rules
match, the main configuration remains unchanged. An
execution override may select `bubblewrap` or `direct`; the final effective
configuration must still pair `direct` with `network.mode = "host"` and
`filesystem.cwd_writable = true` with empty `filesystem.hidden_paths`.

See [Models and authentication](models.md) for the distinction between the
active catalog and packaged defaults, API-key resolution, and model
troubleshooting.

See [User and group environment and overrides](identity-broker.md) to create optional
user/group drop-ins and enable the socket. After installing or upgrading units on a live
host, run `systemctl daemon-reload` before enabling or restarting the socket.

On Linux, disable any enabled optional sockets and stop event-collector
connections before uninstalling:

```sh
sudo systemctl disable --now pi-sandbox-identity-broker.socket pi-sandbox-audit.socket
sudo systemctl stop 'pi-sandbox-audit@*.service'
sudo ./uninstall.sh
```

The uninstaller refuses to remove active or enabled sockets or active
event-collector connections. It never
removes `users.d`, `groups.d`, or their contents, including with `--remove-config`, and reloads
systemd after removing the managed units.

This project does not build an RPM. The archive layout and installer semantics
are intentionally straightforward enough for an administrator to wrap in an
RPM or another site-specific package later.

## User state

Pi continues to store user-controlled state in its normal agent directory,
typically:

```text
~/.pi/agent/
```

`PI_CODING_AGENT_DIR` may select another user-state directory. It affects
credentials, sessions, settings, skills, themes, logs, and caches. It does not
change `/etc/pi-sandbox/config.toml`, the resolved `models_file`, extension
loading, or tool implementations.

Default session files are grouped by workspace under `<agent-dir>/sessions/`.
Configured custom session directories use a flat layout. Enabled retention
scans the selected store before an operational Pi interface starts, normally at
most once every 24 hours, using last-use modification times. The selected
startup session is preserved and refreshed; resumed sessions are also
refreshed. Expired regular session files are removed without loading their
transcript bodies or recursively exploring unrelated directories.

Small scheduling files live in
`<agent-dir>/pi-sandbox/retention/<root-and-layout-hash>.json`. Each stores the
last attempt time and retention value; a policy change triggers another check.
Deleting this state schedules a new sweep on the next launch. No state or
transcript maintenance occurs when `retention_days = 0`. User-state files remain
owned by the invoking user and are not installed or managed by the root
installer. See [session retention](configuration.md#session-retention) for
skip conditions and concurrent-use limits.

## Launch

Change to the project directory and invoke the canonical command:

```sh
cd /home/alice/worktrees/example
pi-sandbox
```

Before starting the interactive application, the executable validates the
compiled extension catalog, loads the base policy, optionally resolves the
calling account and groups, validates the selected extensions, effective model catalog, exact
tool policy, and conditional executable prerequisites, and probes a real
Bubblewrap operation for the launch directory. Any failure stops startup. No
stock tool or host-execution fallback is available.

After selecting the Pi session, startup also awaits optional retention cleanup
before the TUI opens or a noninteractive prompt runs. An interactive sweep
lasting more than about one second prints `Checking for old sessions…`; quick
checks and skipped daily sweeps print nothing. Print, JSON, and RPC modes never
print that message. Cleanup failures are silently tolerated and do not block
startup. Metadata and authentication exits do not run retention maintenance.

The captured directory remains the current directory inside every sandbox
operation and appears at the same absolute path. User/project extensions and Pi
package-management commands are rejected. Skills, `--no-skills`, tool-selection
options, and selection among administratively configured models remain
available.

## Troubleshooting

### Running as root is rejected

Run `pi-sandbox` directly as the intended unprivileged account rather than with
`sudo`. The application does not offer a root-mode configuration switch. Root
remains appropriate for `install.sh`, `uninstall.sh`, and administration of the
system configuration and optional identity broker.

### Administrative configuration is rejected

Confirm that `/etc/pi-sandbox/config.toml` is readable, strictly valid, and
contains an absolute `models_file` whose target is readable and valid. Pi
Sandbox does not fall back to user configuration or Pi's internal model catalog.

### Bubblewrap probe fails

For a system-provider release, confirm the manifest-selected Bubblewrap path is
executable. For a bundled-provider release, confirm `libexec_dir/bwrap` is
present and executable. The installer rejects either provider when it lacks a
required command-line option. If Bubblewrap is present but cannot establish the sandbox, confirm that the host permits
unprivileged user namespaces and that its Bubblewrap version supports the
required options. Pi Sandbox intentionally refuses to run tools directly on
the host when the boundary cannot be established.

### An approval is always denied

`ask` requires Pi's interactive UI. Headless/RPC operation cannot approve a
prompt and therefore denies. Also confirm that the subject is not `deny` or
`disabled` and that no earlier prompt was cancelled.

### A host path is read-only

Check `/sandbox mounts` and the effective `filesystem.cwd_writable` setting.
In Bubblewrap, the launch directory is persistently writable only when that
setting is `true`; with `false`, even approved Bash/write/edit operations cannot
modify it. Private temporary/runtime storage remains writable. Launch from the
intended workspace; changing directories inside Bash does not broaden access.
A read-only launch from exactly `/tmp` is rejected. Use a workspace beneath
`/tmp` or another directory to preserve private writable temporary storage.
Direct execution rejects read-only CWD configuration. Managed host tools use
their separate host authority.

### Networking fails

The packaged `network.mode = "none"` intentionally disables networking for tools
and shell commands. Provider traffic still works because Pi itself remains
host-side. `network.mode = "local"` allows only sandbox-loopback TCP/UDP, so a
host browser cannot connect to a sandbox server. An administrator may select
`network.mode = "host"` for unrestricted host loopback, LAN, and Internet access;
restart `pi-sandbox` after changing the effective configuration.

### Background server stops after a call

The default `execution.process_lifetime = "command"` removes background command
processes after every operation. Select `sandbox` with Bubblewrap to retain
servers and watchers across calls, and redirect their output to files. Active
cancellation, timeout, output overflow or execution failure can still stop all
sandbox command processes. Closing Pi always ends the sandbox. Direct execution
does not support persistent background processes.

### Sandbox execution failure

The current operation fails and no host fallback occurs. Inspect the bounded
diagnostic and correct the command, policy, installation, or host problem. Exit
and relaunch Pi if the sandbox probe or installation admission failed.

## Local syslog integration

Linux releases include `pi-sandbox-audit-collector` and the
`pi-sandbox-audit.socket` / `pi-sandbox-audit@.service` systemd units. Enable the
socket before setting `[audit].enabled = true` in the parent configuration:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pi-sandbox-audit.socket
```

The default endpoint is `/run/pi-sandbox-audit/collector.sock`; a distribution
may select another absolute path at build time with `audit_socket_path`.
The root collector reads the parent configuration for the enabled state and
syslog facility. No user/group rule changes these settings. Identity-broker mode is
not required. The host must provide its standard local syslog socket at
`/dev/log` and `/usr/bin/getent` for trusted account-name lookup. The resolver
uses host NSS and locally reachable account-service sockets; it has no direct
network LDAP access. Name resolution runs once per connection with a four-second
budget. The application allows ten seconds for connection/acknowledgment.
Records use schema 2 and identify each submission with `principal_uid`,
`principal_user` (null if the UID has no account), and `principal_pid`. No
principal GID or group membership is included.

The configuration file and every ancestor directory must be root-owned, must
not be symlinks, and must not be group- or world-writable (normally `0644` for
the file and `0755` for directories). Configuration rejection details appear in
the collector service journal.

The packaged socket allows 128 concurrent connections host-wide and eight per
UID. Each logging-enabled process holds one connection. Exceeding these limits
prevents the additional process from logging and its logged tools fail closed.
Administrators can adjust these limits with a systemd socket unit drop-in.

Events are emitted under the fixed `pi-sandbox` identifier using the configured
`local0` through `local7` facility. Configure the host's logging service to store
and forward those events as desired. There is no application-managed log file,
rotation policy, remote logging destination, or durable-delivery promise. The
application requires an acknowledgment that the collector submitted each
required record to the local syslog socket.

## Release component inventory

Each release includes `sbom.cdx.json`, a CycloneDX 1.6 software bill of materials
covered by the release checksums. It records the application binary hash,
source commit and working-tree status, pinned Pi source and patch provenance,
actual JavaScript bundle inputs, selected compiled extensions, Bun version,
packaged native assets and executable hashes, Linux Rust dependency inventories, and bundled
Bubblewrap when selected. Cargo inventories include build-only dependencies.
System libraries and Bun's internal third-party dependencies are outside the
inventory's stated coverage. Supply the SBOM alongside the matching release
when using dependency scanners.
