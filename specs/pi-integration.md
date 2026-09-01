# Pi integration and upgrade contract

This document is the authoritative behavioral contract for integrating Pi into
Pi Sandbox. Patch files describe how the contract is implemented against one
pinned release; this specification governs when an upstream upgrade requires
those patches to be reimplemented.

## Source pin

`pi-source.lock.json` records the only admitted upstream source:

| Field                  | Pinned value                                                                             |
| ---------------------- | ---------------------------------------------------------------------------------------- |
| Version                | `0.84.3`                                                                                 |
| Tag                    | `v0.84.3`                                                                                |
| Commit                 | `4e58f324fae8ebfa98a3d45181fb248072a2afac`                                               |
| Source archive         | `https://github.com/earendil-works/pi/releases/download/v0.84.3/pi-0.84.3-source.tar.gz` |
| Source archive SHA-256 | `056f84c467450fb5700ad4df9c8cc669bf7f6046976eed7a19eadbc7553b6500`                       |

The build may download that archive or accept the identical archive from a
local path. It must verify the SHA-256 digest before extraction. It extracts Pi
into temporary or ignored build storage and applies the ordered patch series
from `patches/pi`. Neither the upstream archive nor an extracted Pi worktree is
committed to this repository or distributed to installed hosts.

Moving any pinned field is an explicit Pi upgrade. A moving branch, version
range, package-manager resolution, target-host download, or unverified source
tree is not allowed.

## Product boundary

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
- disable Pi's built-in tools and reject any option that restores them;
- reject Pi package install, remove, update, and configuration commands that
  could introduce executable code;
- admit managed host environment values only through the selected compiled
  extension's versioned declaration, never through Pi extension discovery;
- preserve skills, options that disable skills, and options that narrow the
  visible tool catalog; and
- fail closed before interactive startup if managed initialization fails.

No Bubblewrap, approval, tool, argument-filtering, configuration, or installer
policy belongs throughout upstream Pi. Those behaviors remain in Pi Sandbox
modules. The Pi patch series exposes only the generic integration seams that
the private entry point requires.

## Administrative configuration and models

The executable always begins configuration resolution at:

```text
/etc/pi-sandbox/config.toml
```

That path is fixed. No CLI argument, environment variable, Pi setting, project
file, or user file may redirect it. The strict configuration has a required
normalized absolute `models_file`. In broker mode, a root-managed drop-in
selected solely by the kernel-reported UID may replace the model file,
execution backend, network mode, and complete policies for a subset of model
tools. The main TOML supplies the global scoped environment. An optional
version 5 per-UID TOML drop-in may overlay that environment. No other field is
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

## Per-UID resolution

The optional identity broker is a separate static native executable. It is
socket-activated per connection, obtains UID from Linux `SO_PEERCRED`, and reads
only the optional root-owned `/etc/pi-sandbox/users.d/<uid>.toml` selected by
that kernel UID. The request contains no
claimed UID. Requests and responses are single newline-delimited JSON objects;
the Bun client keeps the connection open after writing its request, and the
broker replies when it reads the newline rather than waiting for client EOF. A
successful protocol version 4 response contains exactly the matching UID's
scoped-environment and normalized override patch; username and comment
annotations are never returned. A missing directory or matching file returns
an empty patch and inherits the main configuration unchanged. Broker mode always uses
`/run/pi-sandbox-identity/broker.sock`; neither the drop-in directory nor another
configuration field can redirect it.

The Bun client independently validates the strict response and resolves the
effective configuration in this order: complete main TOML including global
scoped environment, then one per-UID environment, model,
execution, and network override, and atomic complete policy replacements for named tools.
Omitted fields inherit the base. The base TOML remains the global tool policy;
environment entries never select extensions, add or enable tools, or grant
approval. A per-UID complete policy may still deny or disable selected
extension tools such as `git_clone` and `service_api`.

The effective model catalog is loaded with the `pi` scope applied to the
trusted host process. The `sandbox` scope is added to Bubblewrap's cleared
environment or overlaid on the inherited environment of direct built-in
commands. Each `extensions.<id>` scope is admitted only for a selected
compiled extension and names that extension declares; Pi-scoped and other
extension-scoped values are excluded from its executor. Broker failures,
invalid matching drop-ins, invalid responses or scoped environments, and
invalid effective catalogs abort startup. Missing drop-ins do not. Disabled
broker mode skips per-UID lookup but still applies the main configuration's
global scoped environment.

## Required Pi patch behavior

Keep the patch series as small and generic as practical. Against Pi 0.84.3 it
provides these seams:

1. `main()` accepts a caller-provided model-runtime factory and consistently
   uses it for interactive startup and supported authentication paths.
2. Model-runtime construction can exclude the internal provider/model catalog
   without preventing explicitly configured providers from using Pi's trusted
   provider implementations.
3. `main()` can omit Pi's built-in extension factories.

Tests carried in the patch series must prove configured-only model exposure,
absence of built-in fallback after configuration failure, and use of the
injected runtime by every retained entry path. Pi Sandbox tests separately prove
the forced private-entry-point policy.

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
4. Run the focused Pi patch tests and relevant upstream tests offline.
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
`/etc/pi-sandbox/users.d` or its contents, and does not enable or start the
broker socket.

Pi Sandbox does not produce an RPM. Site administrators may wrap the release
archive and these semantics in their own package-management system.
