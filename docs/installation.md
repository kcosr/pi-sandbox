# Installation and operation

The application includes optional subagent support; enable it through the main
`[subagents]` settings, the single `[tools.subagents]` permission policy, and its
`audit.tools.subagents` Boolean. Ordinary Pi distributions
can instead package `@kcosr/pi-subagents-extension`, built and packed alongside the
sandbox and Git packages. Its normal entry needs no Pi Sandbox patches or managed
approval components. See the [package documentation](../packages/subagents-extension/README.md)
for configuration, SDK embedding and the RPC observation contract.

Managed users can disable admitted optional extensions through `/extensions` or
process-only `--disable-extension ID` overrides. Administrators can append
conditional tool guidance through `[extension_guidance]`; see
[optional extension preferences](configuration.md#optional-extension-preferences).

The managed service uses API 1, policy schema 16, rule version 12 and audit
record schema 7. Clients select either service bootstrap or local files at build
time; auditing uses the same service protocol in both profiles.

## Requirements

Installed hosts require x86-64 or arm64 Linux, or x86-64 or arm64 macOS.

Linux Bubblewrap mode requires working unprivileged user namespaces and either
the build-selected system Bubblewrap executable or the release's verified
bundled Bubblewrap executable. Linux direct mode does not use Bubblewrap. Bubblewrap and direct mode require
`fd` (or Debian's `fdfind`), Ripgrep (`rg`), `file`, Bash, a POSIX `/bin/sh`, and
the fixed GNU utilities used by typed tools.

The build and installer validate required Bubblewrap options, including
`--remount-ro` for directory masks and `--ro-bind-data` for empty file masks.

By default, macOS direct and Seatbelt modes require Homebrew `coreutils`, `findutils`,
`grep`, `fd`, and `ripgrep`, plus system Bash, `sh`, and `file`. The
runtime resolves the Homebrew prefix for Apple silicon or Intel and fails
closed if a GNU command is missing. The macOS installer validates the selected
administrative backend before checking these GNU prerequisites. Seatbelt also requires the fixed system `/usr/bin/sandbox-exec`. A macOS release build additionally requires
Homebrew GNU tar (`gtar`) for reproducible archives.

A build-selected macOS tool bundle can supply any of those tool commands,
including host `fd` and `rg`, with its required libraries. Selected bundled
commands replace only their corresponding system prerequisites. System Bash,
`sh`, `file`, and fixed `/usr/bin/sandbox-exec` remain required unless the first
three are themselves selected. The bundle records its architecture and minimum
macOS version; each target needs native qualification. GNU tar remains a build
dependency and is not a runtime bundle command.

Configured home-directory expansion requires `/usr/bin/getent` on Linux or
the system `/usr/bin/dscacheutil` on macOS. The runtime queries the effective
user's OS account with a five-second deadline and a cleared environment; it
does not use `HOME` as a fallback. Operational startup shares this lookup with
the optional user-home prompt context in Bubblewrap and Seatbelt sessions. Direct
execution does not request that optional context. A missing command, missing account,
invalid home, or lookup failure stops startup when configured account expansion
requires it; otherwise the optional user-home hint is omitted. Installation
validation performs no account lookup.

Selected managed extensions add conditional absolute-executable requirements.
The Git extension requires `/usr/bin/git`. Startup validates the requirements
for every selected managed extension; separately maintained executables and
their configuration remain deployment inputs.

The application and Linux service are prebuilt. Installed hosts need no Bun,
Node.js, Rust, compiler or source checkout. Local builds with audit disabled need
no service. Service-source clients require their compiled Unix or HTTPS endpoint;
local builds can compile an optional audit endpoint. macOS supports HTTPS clients,
including audit events, but does not install a native daemon. HTTPS Linux clients
also need no daemon on the client host.

## Release archive and installed layout

Client archives contain the executable, adjacent assets, manifests, SBOM,
checksums and transactional installation scripts. Linux defaults are:

```text
/usr/bin/pi-sandbox -> /usr/libexec/pi-sandbox/pi-sandbox
/usr/libexec/pi-sandbox/
  pi-sandbox
  bwrap                         # bundled-provider releases only
  package.json
  release-manifest.json
  sbom.cdx.json
  theme/
  assets/
  export-html/
  photon_rs_bg.wasm
  native/linux/prebuilds/<platform>/linux-platform-x11.node
  skills/                       # optional selected skill tree
  skills-modes.txt               # complete, checksummed modes when selected
  defaults/                     # LOCAL configuration builds only
    config.toml
    models.json
  licenses/
```

macOS uses `/usr/local/bin/pi-sandbox` and `/usr/local/libexec/pi-sandbox`, with
its native `darwin-platform.node` asset. Neither client archive includes broker,
collector or systemd units. Local defaults install under the compiled `config_dir`
(`/etc/pi-sandbox` in the public distribution); service-source archives contain
no local administrative defaults and create no configuration directory.

Linux builds also emit an independent `pi-sandbox-service-VERSION-linux-ARCH.tar.gz`:

```text
/usr/libexec/pi-sandbox-service/pi-sandbox-service
/usr/lib/systemd/system/pi-sandbox-service.service
/usr/share/pi-sandbox-service/examples/
```

The service archive includes its own SBOM, static Rust/TLS dependency licenses,
checksums and install/uninstall scripts. It never provisions live policy, rules,
passwords or TLS keys. Deployment owns `/etc/pi-sandbox-service/main/service.toml` and
service activation. Examples are templates, not active configuration. The daemon
unit is one concurrent root process with `MemoryMax=4G`, `TasksMax=256` and
`LimitNOFILE=16384`; it owns `/run/pi-sandbox` and is not socket activated per user.
HTTPS-only deployments may instead run the executable directly as an unprivileged
account with protected account-owned inputs, including under that account's home.
See [foreground HTTPS operation](managed-service.md#foreground-https-only-operation)
for validation, file modes, descriptor limits and syslog requirements. The packaged
installer and unit retain their root-managed system layout.

Common client installation paths and native tool selection are compiled into the
application and rendered into the installer and release manifest. A `DESTDIR`
changes only the installation destination, never the runtime endpoint or source.
Deployment-owned user/group rules belong to service listener rule directories;
client installers do not create or modify them.

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

Local builds read their compiled `config_dir/config.toml` and its required
`models_file` once. Only local builds explicitly compiled with
`allow_config_override = true` admit a leading `--config FILE`. Service builds
admit neither local file selection nor an environment endpoint override. They
fetch policy, account overrides, environment and model catalog in memory through
the compiled endpoint. See [configuration modes](configuration.md).

## Building a release

The product version is independent of the pinned Pi version. A clean build at
product tag `v0.14.0` displays `1.5.0+ps.0.14.0` in `pi-sandbox --version` and
the TUI header. Untagged builds include a development suffix and Git revision;
modified builds also include `.dirty`. Source execution and application builds
without Git metadata use `.dev.source`; `npm run build:application` supports
that case. The full release builder requires a Git checkout for source
provenance. Product version `0.14.0` pins Pi's internal version to `1.5.0`.

GitHub releases publish source and release notes without uploaded binaries.
The following commands build deployment archives locally. See
[versions and releases](releases.md) for tagging, changelog maintenance, and
building from the final release tag.

Release builds use Node.js 24 or newer with `NODE_ENV` unset. Linux release
builds also use Rust/Cargo 1.85 or newer; Rust dependencies are pinned and
vendored so the service builds offline:

```sh
env -u NODE_ENV npm ci
env -u NODE_ENV npm run build:release
```

`build:release` compiles and packages without running test suites. It still
verifies pinned source hashes, configuration and distribution inputs, package
layout, SBOM, manifests, checksums, version and installation metadata. It does
not start operational sessions or require a running policy or audit service.
Use `verify:release` with the same arguments when qualification is wanted: it
runs the full repository suites, patched-Pi API/integration/theme tests and
packaged-runtime smoke checks as well as the same build/package/integrity path.
There is no test-skipping flag and no need to edit source to package a build.
For example, `--pi-source-archive /path/to/pi-1.5.0-source.tar.gz` supplies the
same checksum-verified source to either command.

One strict TOML distribution manifest selects all extension manifests and the
platform installation layouts. For example:

```sh
env -u NODE_ENV npm run build:release -- \
  --distribution /path/to/company/pi-sandbox-distribution.toml
```

```toml
version = 4
extension_manifests = ["/path/to/pi-sandbox-extension.json"]

[platforms.linux]
libexec_dir = "/usr/libexec/pi-sandbox"
launcher_path = "/usr/bin/pi-sandbox"
[platforms.linux.configuration]
source = "local"
config_dir = "/etc/pi-sandbox"
allow_config_override = false
[platforms.linux.bubblewrap]
mode = "system"
path = "/usr/bin/bwrap"

[platforms.darwin]
libexec_dir = "/usr/local/libexec/pi-sandbox"
launcher_path = "/usr/local/bin/pi-sandbox"
[platforms.darwin.configuration]
source = "service"
[platforms.darwin.configuration.endpoint]
transport = "https"
url = "https://policy.example.org/v1/service"
basic_username = "company-macos"
basic_password_file = "/private/build-inputs/service-password"
send_machine_id = false
# Optional custom CA bundle; omit to use public CA roots:
# tls_ca_file = "/private/build-inputs/internal-ca.pem"
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

macOS can additionally select a prepared native tool artifact:

```toml
[platforms.darwin.tool_bundle]
directory = "./build-inputs/tools-darwin-arm64"
inventory_sha256 = "<lowercase SHA-256 of inventory.json>"
commands = ["cat", "chmod", "fd", "find", "grep", "head", "mkdir", "mv", "rg", "rm", "sha256sum", "sort", "tail", "test", "wc"]
```

This optional table contains exactly those three fields. Omitting it retains
system command selection. `directory` resolves relative to the manifest and
must be a canonical directory with no symlink components. Supported command
names are `bash`, `sh`, `cat`, `chmod`, `mkdir`, `mv`, `rm`, `grep`, `file`,
`find`, `head`, `sha256sum`, `sort`, `tail`, `test`, `wc`, `fd`, and `rg`.
The selection must exactly match its `bin/` entries. This first bundle validator
supports native Darwin builds only; Linux continues using its existing providers.

Typed tools no longer require GNU Awk. When upgrading a custom bundle that
includes it, remove `awk` from the selection and `bin/awk` from the artifact and
inventory, remove any dependencies and source/license entries used only by it,
and repin `inventory_sha256`. The installers still use the host's ordinary
`awk` to read package metadata; macOS supplies that command without Homebrew.

The strict `inventory.json` has version `1`, platform `"darwin"`, architecture
`"arm64"` or `"x64"`, `minimumOS` such as `"26.0"`, and `files` and `sources`
arrays. Every file entry has `path`, final `sha256`, `mode`, byte `size`, and
`source`. Native entries also have `originalSha256`, recording the bytes before
relocation or signing. Native paths are `bin/<command>` or `lib/<name>.dylib`
with mode `"0755"`; license files reside below `licenses/` with mode `"0644"`.
Every source has `name`, `version`, `license`, `sourceUrl`, `sourceSha256`,
`binaryUrl`, `binarySha256`, and nonempty `licenseFiles` naming its packaged
notices. URLs are HTTPS and digests lowercase SHA-256. Original/source digests
are provenance supplied by the artifact producer; the builder verifies the
pinned inventory and every final file, not remote source archives.

Unlisted files/directories, missing files, symlinks, traversal, unknown fields,
incorrect modes or hashes are rejected. Native builds inspect each executable
and dylib's actual architecture, minimum OS, loader imports and signature.
Dependencies must resolve to system libraries or inventoried libraries via
`@loader_path`; external Homebrew paths and `LC_RPATH` are rejected. Artifact
producers must relocate dependent dylibs, sign changed native files, preserve
licenses and record original/final hashes before pinning the inventory. The
builder does not download or repair tool artifacts.
Artifact producers must retain corresponding source archives, patches and build
recipes and fulfill the bundled components' license and redistribution terms;
an inventory of source URLs and digests does not itself supply those materials.

Managed releases copy the complete artifact to `libexec_dir/tools`, preserve
native executable modes during installation, and include its identity and
source/file hashes in the release manifest and SBOM. Runtime paths are anchored
beside the real managed executable, allowing extracted archives to relocate
together. Selected host `fd`/`rg` paths precede Pi's cache and PATH lookup; a
missing selected file fails without fallback or download. No TOML runtime,
standalone JSON, or environment setting can replace this build selection.
Separately installed administrator utilities can be added to managed command
lookup with [`execution.command_path_prepend`](configuration.md#command-search-path).
It leaves bundle precedence and fixed typed-tool selection intact. The setting
neither packages the utilities nor creates new filesystem grants.

`node scripts/build-extensions.mjs --distribution FILE` and
`node scripts/pack-extensions.mjs OUTPUT --distribution FILE` use the same
verified input for the standalone sandbox package. Its tools reside under
`dist/native-tools`, resolve relative to the extracted package, and are recorded in
package provenance. Ordinary builds remain JavaScript-only. A bundle-bearing
package is specific to its recorded OS/architecture/minimum version; consumers
that rebundle its JavaScript must preserve that tools layout or construct an
executor with their own trusted `toolBundle` metadata. Neither path creates an
administrator tool-directory policy.
Stock Pi's own interactive `fd`/`rg` helpers retain stock Pi's cache/PATH
selection; the managed host-tool seam is not part of the standalone extension.
The standalone package's immutable selection governs its executor commands.

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

The version-4 descriptor requires the strict `configuration` union. Local builds
require `config_dir` and `allow_config_override`; `audit_endpoint` is optional and
uses the same endpoint shape as service builds. Service builds require `endpoint`
and reject local config fields. Unix endpoints require Linux and an absolute
`socket_path`. HTTPS endpoints require the exact `/v1/service` URL, build-time
Basic credential input and explicit `send_machine_id` (true is macOS-only).
Endpoint, credentials and CA roots are fixed in the executable. Build inputs are
not runtime environment variables. There is no fallback to local files.

HTTPS builds, including local builds with HTTPS auditing, are deployment-private:
credentials can be extracted by users who control their machines. Public examples
contain no usable credential. The builder redacts credential contents and input
paths from release metadata and protects credential-bearing archives with mode 0600. Public CA roots are the default; an explicit CA bundle replaces that trust
set. Plain HTTP, redirects, userinfo and ambient proxy/CA overrides are rejected.

Local release builds accept `--config` and `--models`; the default policy must
point `models_file` at `config_dir/models.json`. Service release builds reject
those options and omit `defaults/`. Older distribution schemas and former socket,
service-directory and top-level configuration fields are rejected.

Release compilation requires Bun 1.4.4 or newer stable. Earlier runtimes can add
ambient or system CAs to an explicit CA set, violating the service trust boundary.
The builder checks this minimum before creating build output. The Bun version is
recorded in the SBOM; deployed applications embed that runtime and need rebuilding
to receive runtime or bundled-root updates. JavaScript-only development builds do
not compile a Bun runtime.

The build produces a native archive for its current Linux or macOS architecture.
It downloads, or accepts a locally supplied copy of, the official Pi
1.5.0 source archive pinned in `pi-source.lock.json`. It verifies the recorded
SHA-256 digest, extracts the source into temporary or ignored build storage,
applies the small patch series in `patches/pi`, compiles Pi plus the separate Pi
Sandbox extension and selected modules into the Bun application, and
builds the separate service archive with a static native executable on Linux. Pi still loads only the single
forced Pi Sandbox extension factory. The extracted Pi worktree and external
extension sources are not included in the release archive.

See [Pi integration and upgrade contract](../specs/pi-integration.md) for the
authoritative upstream contract.

### Bundling shared skills

A version-4 distribution can select a prepared directory with a top-level input
resolved relative to its manifest:

```toml
skills_source = "./shared-skills"
```

The builder copies the complete tree, including support files, into
`payload/pi-sandbox/skills`. Installation places it at the selected platform's
`libexec_dir/skills`. For local builds, the selected default policy must explicitly include that
exact installed root in `[skills].directories`; selecting a source does not
silently activate an implicit runtime path. Conversely, defaults referencing
that package-owned root or a descendant require a source containing the directory.
Use platform-specific default policies when platform layouts differ.

Prepared trees permit regular files and directories, including empty directories.
Symlinks and special files are rejected. Packaged path components must use
printable ASCII without spaces or backslashes; external skill roots have no such
packaging restriction. Directories install as `0755`; files with any source execute
bit install as `0755`, and other files as `0644`. The checksummed
`skills-modes.txt` contains the sorted complete regular-file inventory. Installers
validate it and restore those modes after ordinary payload normalization using
existing shell/awk prerequisites. The release manifest and SBOM include the
bundle's hashes, modes and prepared-tree provenance. A selected empty tree has
an empty sidecar; an unselected bundle has neither directory nor sidecar.

Local upgrades validate retained or replacement policy against the candidate
payload before publication. External roots remain symbolic during this offline
check. Service-source builds with selected skills require live target-account
validation: `install.sh --validation-user NAME` (repeat for each deployment policy
or permission context). The fetched policy must include the exact installed
`libexec_dir/skills` root. The installer stages final modes beneath the traversable
root-owned libexec parent, then invokes the staged candidate from `/` under each
non-root account with a clean environment. This avoids unreadable root unpack
paths. Failure leaves the installed payload intact. Runtime checks roots for every
invoking user, including accounts added later.

`DESTDIR` is offline packaging: verify payload inventory, modes and compiled
capabilities without service contact or account switching; reject
`--validation-user`. A subsequently installed service skills package still needs
the live target-account check. Offline staging does not certify live policy or
skill access. External skill trees are never copied or removed.

## Installing and upgrading

Extract the client archive and run `sudo ./install.sh`. Run the application as the
intended non-root user. The installer verifies checksums, complete asset/mode
inventory, compiled source, platform and architecture before publishing the
payload. It checks selected native prerequisites without installing OS packages.
No installer contacts a model provider or starts Pi tools.

Local installations copy defaults only when absent and preserve existing policy
on ordinary upgrades. The candidate runs
`--validate-installation [--root DIR] --candidate-payload DIR` before the payload
swap, validating all workspace modes, model authentication admission and inventory
without reading referenced secrets or resolving user/machine macros. Successful
stdout is the authored default backend. `--replace-config` validates packaged
policy/catalog in a private staging tree and retains the existing backup/rollback
transaction. Local uninstall retains configuration unless `--remove-config` is
explicitly selected. Local installations do not accept `--validation-user`.

Service installations reject `--replace-config`; uninstall rejects
`--remove-config`. `--print-build-capabilities` is offline and reports compiled
source, native providers and inventory hashes, not an effective backend. Service
policy can be qualified with `--validate-service --candidate-payload DIR`, run as
the intended non-root account on its target platform. The command fetches and
validates one bootstrap entirely in memory, including resolved secrets, all modes,
the account default, candidate skills and bounded backend capability checks. It
never constructs an operational executor. Output contains status and opaque
revision, never configuration contents. Validation is mandatory before publication
for service packages with bundled skills, using `--validation-user` as described
above. Runtime still validates its own fresh snapshot.

Both profiles support offline `--validate-bootstrap FILE --candidate-payload DIR`
for a synthetic successful bootstrap envelope. It performs symbolic validation,
not an operational policy-source override. Test bundles are private temporary
fixtures. Production service validation does not export secrets to a bundle.

Policy schema 16 retains workspace selection semantics and requires
`model_auth.personal_providers`. Remove authored `identity` and `audit.facility`;
facility belongs to the service listener. Service rules use version 12. Update
rules and policy explicitly before activation; no compatibility parser or automatic
conversion is supplied. A service client never reads client-side rules. Linux Unix
listeners resolve kernel-authenticated accounts and host groups; HTTPS listeners
use asserted usernames and admit username rules only. See the
[rule contract](managed-service.md) and [model authentication](models.md).

Install the independent Linux service archive separately. Provision protected
manifest, policy/catalog/rule files and TLS/password inputs, then run:

```sh
sudo /usr/libexec/pi-sandbox-service/pi-sandbox-service --validate --manifest /etc/pi-sandbox-service/main/service.toml
sudo systemctl daemon-reload
sudo systemctl enable --now pi-sandbox-service.service
```

Offline daemon validation checks source shape and protected metadata without
reading password, private-key or environment-secret contents. Activation validates
TLS/key pairing and credentials. Restart the daemon for manifest/TLS/credential
changes; new bootstrap requests read current policy and rules. Existing application
processes retain their captured configuration snapshot. To uninstall the daemon,
disable and stop `pi-sandbox-service.service`, then run its archive's uninstaller.
Live deployment configuration, keys and passwords remain untouched. Client
uninstall does not affect the independent service.

The client installer serializes updates with a lock under its libexec parent. If
an interrupted installation leaves a lock, verify that no installer is running
before removing it. `DESTDIR` supports non-root offline image staging; it does not
redirect runtime authority. No RPM or automatic logging-system configuration is
provided. macOS architecture qualification remains native and separate.

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

Use `pi-sandbox --list-workspace-modes` to inspect the modes your account may
select, descriptions and default. Select one with `--workspace-mode NAME`
before Pi arguments; without that flag the configured effective default applies.
For builds permitting caller-selected policy, the optional `--config FILE`
prefix must come first. Listing uses main validation and existing identity
resolution without starting a model session or executor.

Before starting the interactive application, the executable validates the
compiled extension catalog, loads and validates every main-authored mode, checks
platform compatibility before service bootstrap, resolves account mode access and
selection, applies remaining account policy, and validates the final platform,
selected extensions, effective model catalog, exact
tool policy, and conditional executable prerequisites, and probes the selected
execution backend for the launch directory. Any failure stops startup. No
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
system configuration and configured service.

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
host-side. Only Linux Bubblewrap supports `network.mode = "local"`; it allows
private sandbox-loopback TCP/UDP, so a host browser cannot connect to a sandbox
server. Seatbelt supports only `none` or `host`. An administrator may select
`network.mode = "host"` for unrestricted host loopback, LAN, and Internet access;
restart `pi-sandbox` after changing the effective configuration.

### Background server stops after a call

Background descendants may survive normal command completion on every backend.
Redirect their input/output to files so closing the originating call's streams does
not produce a broken pipe. Individual cancellation or failure does not sweep unrelated
commands. Closing the Linux executor terminates its sandbox namespace; direct and
Seatbelt termination is best effort and survivors may remain. No lifecycle switch
or watcher is required. See [command scheduling and cleanup](configuration.md#command-scheduling-timeouts-and-cleanup).

### Sandbox execution failure

The current operation fails and no host fallback occurs. Inspect the bounded
diagnostic and correct the command, policy, installation, or host problem. Exit
and relaunch Pi if the sandbox probe or installation admission failed.

## Local syslog integration

The Linux daemon accepts bootstrap, policy inspection and audit operations on one
`POST /v1/service` protocol over Unix sockets or HTTPS. Each listener requires
`audit_facility = "local0"` through `"local7"`; current policy `audit.enabled`
controls audit opening. Local-source audit clients use their compiled optional
endpoint and explicit local policy provenance. Service-source clients attach the
opaque revision of their captured bootstrap. These identifiers are provenance,
not attestations or durable receipts.

The host supplies `/dev/log`. Every accepted event is a bounded schema-7 syslog
datagram under `pi-sandbox`, with Unix peer or HTTPS asserted identity, session,
sequence and policy origin. The daemon resolves the local syslog destination on
each send, so logging-socket replacement can recover. Host logging owns storage,
forwarding and retention. ACK means local syslog submission, not durable storage.

An audited tool/export must receive its required pre-effect ACK before proceeding.
Failures invalidate the audit handle and fail the operation; events and tool
execution are not replayed. A later explicit user submission performs the bounded
reconnect checkpoint, so an outage does not permanently poison the application.
Registered local commands remain available. Shared root/subagent audit state and
independent daemon sessions preserve concurrent execution without a global tool
serialization gate.

Manifest limits bound connections and sessions independently of the fixed worker
pools. Defaults are 128 total connections, 16 per UID/32 per IP and 256 sessions,
8 per principal; supported ceilings are documented in the service specification.
The six-second request deadline and bounded queues do not promise cancellation of
blocked host filesystem I/O. Service operational logs omit credentials, environment
values and request bodies. HTTPS shared credentials authorize ingress and cannot
prove a root-controlled Mac's asserted username. See [security](security.md).

## Release component inventory

Each release includes `sbom.cdx.json`, a CycloneDX 1.6 software bill of materials
covered by the release checksums. It records the application binary hash,
source commit and working-tree status, pinned Pi source and patch provenance,
actual JavaScript bundle inputs, selected compiled extensions, Bun version,
packaged native assets and executable hashes, and bundled
Bubblewrap when selected. The independent service SBOM records pinned Rust/TLS runtime and build dependencies.
System libraries and Bun's internal third-party dependencies are outside the
inventory's stated coverage. Supply the SBOM alongside the matching release
when using dependency scanners.

## Ordinary Pi extension packages

The release build creates `kcosr-pi-sandbox-extension-0.10.0.tgz`,
`kcosr-pi-git-extension-0.3.0.tgz` and `kcosr-pi-subagents-extension-0.2.0.tgz`,
each with a SHA256 sidecar. They are independent
standard extensions for ordinary Pi 1.5.0. Sandbox includes its runtime and
Bubblewrap worker; Git includes its bounded host runner; subagents use public SDK
sessions. None needs a permissions package, another extension package or an
adjacent source checkout. See [sandbox configuration and usage](../packages/sandbox-extension/README.md),
[Git configuration and usage](../packages/git-extension/README.md) and
[subagent configuration and usage](../packages/subagents-extension/README.md).
The managed executable embeds the reusable implementations through its own
adapters and preserves administrator-selected permissions and audit controls.

### Workspace policy migration

To preserve an existing schema-14 deployment's behavior:

1. Set main schema 16. Move every named tool's inline audit Boolean to
   `audit.tools`, remove the old fields and leave MCP per-rule audit unchanged.
2. Keep existing filesystem, exports and invocation values as common defaults.
   Add one administrator-named empty mode, and make it the sole allowed and
   default choice. An optional description explains that choice to users.
3. Update any user/group rule files to version 12. They may omit workspace
   metadata to inherit the main selection choices.
4. Before adding modes, review mode-agnostic account CWD and tool overrides.
   They apply after selection: writable-CWD overrides change workspace protection
   while preserving export availability on confined backends, and tool overrides
   may replace a mode's approval behavior. Move those
   differences into mode definitions and account grants where intended.
   Newly enabled confined host exports also require reviewing account backend
   overrides: an effective `direct` backend needs an administrator-authored mode
   with `exports.enabled = false` and suitable allowed/default selection. Account
   rules cannot disable exports.
5. Add other mode definitions and allowed/default grants deliberately. Validate
   all definitions and relevant account combinations before deploying matching
   application and service components.

Fresh confined packages offer host and sandbox with host as default and exports
enabled in both modes; direct packages offer only host with exports disabled.
Seatbelt keeps Bash disabled in both packaged modes.
Ordinary upgrades preserve site policy instead of replacing it with those new
choices. Both installers validate retained main configuration before swapping
binaries, but do not validate live service rules. There is no compatibility parser,
automatic conversion or persistent scratch storage.
