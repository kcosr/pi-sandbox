# Pi integration and upgrade contract

This document is the authoritative behavioral contract for integrating Pi into
Pi Sandbox. Patch files describe how the contract is implemented against one
pinned release; this specification governs when an upstream upgrade requires
those patches to be reimplemented.

## Source pin

`pi-source.lock.json` records the only admitted upstream source:

| Field                  | Pinned value                                                                           |
| ---------------------- | -------------------------------------------------------------------------------------- |
| Version                | `1.0.0`                                                                                |
| Tag                    | `v1.0.0`                                                                               |
| Commit                 | `a13d35a742c6ef8462812a28fbe1d8c8b7431c32`                                             |
| Source archive         | `https://github.com/earendil-works/pi/releases/download/v1.0.0/pi-1.0.0-source.tar.gz` |
| Source archive SHA-256 | `89089c82d41759b800124a77e212adaa867caaa9d1269d8012ef0df9bc86b92e`                     |

The build may download that archive or accept the identical archive from a
local path. It must verify the SHA-256 digest before extraction. It extracts Pi
into temporary or ignored build storage and applies the ordered patch series
from `patches/pi`. Neither the upstream archive nor an extracted Pi worktree is
committed to this repository or distributed to installed hosts.

Moving any pinned field is an explicit Pi upgrade. A moving branch, version
range, package-manager resolution, target-host download, or unverified source
tree is not allowed. The integration targets Pi 1.0 only; it does not retain
pre-1.0 API or launch compatibility paths.

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
- disable Pi's built-in MCP, codemode, tool-search, and llama extensions and
  reject the MCP management command;
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

Keep the patch series as small and generic as practical. Against Pi 1.0.0 it
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
`/etc/pi-sandbox/users.d`, `/etc/pi-sandbox/groups.d`, or their contents, and does not enable or start the
broker socket.

Pi Sandbox does not produce an RPM. Site administrators may wrap the release
archive and these semantics in their own package-management system.

## CWD filesystem access

Administrative configuration requires `[filesystem].cwd_writable`, with `true`
in packaged defaults. Root-managed user/group rules may replace that setting under
`[overrides.filesystem]`. Effective direct execution requires `true`.

The Bubblewrap backend always creates an explicit same-path CWD bind after its
private mounts: writable with `--bind`, read-only with `--ro-bind`. This preserves
visibility for `/tmp`-based workspaces independently of write permission and does
not by itself change host visibility. Schema 7 also requires
`[filesystem].hidden_paths` (empty by default), a main-policy-only list of canonical
existing directories masked by private read-only mounts. Hidden ancestors precede
the CWD restore; explicit hidden descendants follow it. Broker filesystem overrides
change only `cwd_writable` and cannot clear these masks. Effective direct execution
requires empty hidden paths. Host Pi context/session loading remains outside the
tool namespace. Private temporary/runtime
storage remains writable. Read-only CWD exactly `/tmp` is rejected because its
bind would mask private `/tmp`. Existing root and private-system-path overlap
rejections remain enforced. The setting applies to built-ins and user shell;
managed host tools retain their declared host authority.
