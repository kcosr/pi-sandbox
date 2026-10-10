# Testing

## Reusable extension acceptance

Shared package unit tests run with `npm run test:unit`. `npm run test:extension`
builds and inspects an npm-format tarball, imports its public entries and starts
ordinary Pi 1.1.0 against the extracted artifact. On Linux this requires genuine
Bubblewrap, Node 24 and Bun 1.3.14+; it exercises both worker runtimes and verifies
that conversation replacement retains a single namespace and background job in
sandbox-lifetime mode. No model service is contacted. Managed release checks
continue to cover forced composition, permissions, MCP, Code Mode and packaging.

Pi Sandbox tests are offline. They never invoke a live model provider and never
depend on provider credentials.

## Verification sequence

Install dependencies with `NODE_ENV` unset, then run the fail-closed local
release verifier:

```sh
env -u NODE_ENV npm ci
env -u NODE_ENV npm run verify:release
```

To use a previously downloaded pinned Pi source archive, pass it through:

```sh
env -u NODE_ENV npm run verify:release -- --pi-source-archive /path/to/pi-1.1.0-source.tar.gz
```

The verifier runs formatting, lint, type checking, Rust service checks, unit,
integration, real-Bubblewrap, package/install, build, archive inspection, and
packaged executable diagnostic checks as distinct observable steps. A supported release
host must execute the Bubblewrap suites rather than accepting a skip caused by
unavailable namespaces.

Linux real-Bubblewrap tests also require Python 3 for offline socket-family and
namespace probes. This is a test-host dependency, not an application runtime
dependency.

## Test layers

### Unit

- strict versioned TOML parsing;
- compiled extension catalog, manifest, schema, identifier, and collision
  validation;
- required extension selection and exact dynamic model-tool policy sets;
- strict `none`, `local`, and `host` network modes, and optional process lifetime;
- fieldwise execution overrides, `none < local < host` and `command < sandbox`
  joins, omission inheritance, and rejection of effective direct persistence;
- required CWD write-access configuration, parent inheritance and user/group overrides,
  with direct/read-only rejection before and after override application;
- required hidden paths, strict path syntax and uniqueness, immutable
  main-policy inheritance, direct-mode rejection, and mount ordering around CWD;
- account-home expansion for configured hidden paths and all scoped environment
  values after broker merge, independence from ambient `HOME` and CWD, literal
  nonmatching strings, post-expansion bounds, and installation validation without
  account-home lookup;
- required session retention, integer bounds, explicit zero-disable behavior,
  and rejection of user/group retention overrides;
- last-use timestamp updates, daily scheduling and policy-change retries,
  shallow default/custom storage scans, bounded expired-header checks, symlink
  and malformed-file skips, current-session preservation, and nonfatal failures;
- delayed interactive cleanup progress without output in print, JSON, or RPC;
- all required model-tool policies and unknown-field rejection;
- mode and session-grant decisions;
- memory-only grants scoped by approval subject;
- no-UI, prompt cancellation, and prompt failure denial;
- managed-executable argument filtering;
- rejection of Pi package-management commands;
- build-gated configuration selection, rejection in managed builds, and absolute model-path resolution;
- effective-UID root rejection for Pi, help, and worker execution, with only
  installer-owned validation commands admitted as root;
- strict system-versus-bundled Bubblewrap distribution selection and immutable
  compiled runtime path;
- strict broker protocol and user/group TOML parsing, named/numeric selectors,
  primary/supplementary membership, least-restrictive joins, conflict rejection,
  and bounded host resolver failures,
  global-plus-combined-rule scoped environment overlay, missing-drop-in inheritance,
  environment bounds and reserved-name rejection, dynamic
  User/group rule execution and tool override validation, effective backend/network
  validation, active-policy cross-checking, atomic
  per-user override merging, and the compiled Bun client's no-half-close request
  flow;
- direct-argv host execution, per-extension declared environment admission,
  cross-extension and Pi-variable isolation, inherited-variable removal and
  fixed overlays, bounds, process-group cleanup, and fixed launch CWD;
- Git locator parsing, exact scheme/host admission, safe derived destination,
  and rejection of options, local transports, bad basenames, and arbitrary
  targets;
- standard Pi tool-only factory capture, declaration matching, and policy wrapping;
- command/input/output/time limits and cancellation; and
- exact dynamic tool-catalog construction.

### Integration

A deterministic fake Pi API loads the built extension without contacting a
provider. It proves that:

- all seven non-disabled replacement tools register with the expected names;
- selected, non-disabled managed-extension tools register while unselected or
  disabled extension tools do not;
- managed API version 3 call summaries render identifying fields in Pi's tool
  card and reject control characters or oversized output;
- user/group complete policies can deny or disable `git_clone` and other selected tools,
  while environment values alone never alter the tool catalog or decisions;
- disabled tools are absent;
- allowed and approved calls execute the exact immutable request through the
  tool's declared sandbox or host boundary;
- denied and cancelled calls never reach an executor;
- model Bash is policy-gated while user `!` shell runs without a prompt;
- `/sandbox` diagnostics report the admitted mount policy, effective tool
  policy, and current session grants without invoking the executor;
- every user-shell error explicitly blocks instead of falling through; and
- session shutdown clears grants without closing the process-owned sandbox;
- enabled retention refreshes session modification time on logical session
  activation, and disabled retention performs no timestamp maintenance.

Host-tool integration uses a mocked host executor and local fixtures only. It
proves that `git_clone` constructs `/usr/bin/git clone --` with one derived
child. Tests do not contact Git hosts or a broker service.

### Real Bubblewrap

Tests execute a disposable fixture through the installed `bwrap` binary and
prove kernel-observable properties:

- `pwd` and absolute paths match the host launch CWD;
- the launch CWD can be created, changed, and deleted;
- an existing fixture outside the launch CWD is readable but cannot be changed;
- read-only CWD access retains an explicit same-path bind after private mounts;
- with model Bash allowed, Bash/write/edit cannot mutate read-only CWD files or
  other host files, while read operations still see CWD contents;
- read-only `/tmp`-based workspaces remain visible, and private `/tmp` and `/run`
  remain writable without creating corresponding host files;
- read-only CWD exactly `/tmp` is rejected before worker startup;
- hidden runs parents restore only the launch CWD, with sibling/transcript/interior
  contents inaccessible through absolute paths, `..`, and symlinks;
- hidden masks remain read-only even after attempted chmod, while restored CWD
  honors writable/read-only policy and ordinary utilities remain available;
- hidden regular files read as empty through absolute, relative, and symlink
  references, including beneath a restored CWD or private `/tmp`;
- attempts to write after chmod, unlink, rename, or overwrite hidden file mounts
  fail while original host contents and permissions remain unchanged;
- missing hidden targets are silently skipped without creating host placeholders;
  existing targets remain masked, and skipped paths created later on the host can
  become visible until restart;
- permission errors, non-directory ancestors, special files, and symlink
  entries/ancestors fail startup, including dangling links and symlink ancestors
  of missing targets;
- file-mask input descriptors close on worker startup failure, and a Bun-hosted
  executor establishes multiple file masks without waiting on empty JS pipes;
- `/tmp` is writable, private from host `/tmp`, and persistent between calls in
  one Pi process;
- commands are serialized through one stable sandbox namespace;
- host pseudo-filesystems and privileged sockets are not exposed;
- TCP and pathname Unix-socket attempts inside and outside the writable CWD
  fail in offline mode;
- host mode reaches a host-loopback listener;
- local mode permits IPv4/IPv6 TCP/UDP loopback while host listeners, named Unix
  sockets and external routes remain unavailable;
- datagram socket pairs cannot reconnect to host sockets in `none` or `local`,
  with a host-mode positive control; Bun stream-pair child spawning still works;
- a server started in one call is reachable with curl from another under local
  networking and sandbox process lifetime, while default command lifetime kills it;
- post-exit output restarts the 100 ms idle timer; silent inherited pipes release
  the call, completed output cannot corrupt later calls, and timeout/output bounds
  still apply to continuously arriving output;
- cancellation, timeout, output overflow and shutdown also remove previously
  started background servers, including detached processes;
- `io_uring` cannot reopen socket authority on kernels where setup is otherwise
  permitted;
- sandboxed `link` creation fails while pre-existing hard links remain the
  documented residual risk;
- ambient credential and agent variables are absent;
- Pi- and extension-scoped configured values are absent, while configured sandbox
  values are present and fixed sandbox variables cannot be replaced;
- all seven tools and user shell cross the Bubblewrap boundary;
- `/usr/bin/git` remains visible inside Bubblewrap so repository-local branch,
  status, and diff operations use the ordinary sandboxed Bash path;
- cancellation and process shutdown kill active work and descendants; and
- sandbox startup or execution failure never triggers host execution.

Direct-executor tests separately prove Linux direct execution, host-home path
resolution, ambient-plus-scoped environment construction, direct-argv request
bounds, cancellation/error mapping, and unsupported-platform failure. Config
tests prove direct mode requires explicit host networking. macOS command-profile
tests and native release validation require the declared Homebrew GNU tools;
they never substitute BSD utility semantics.

Host fixtures use a disposable parent with separate `workspace` and
`outside` directories. Tests must never use the repository root or a user's home
directory as a mutation target.

### Package and installation smoke

Smoke coverage builds the distributable package, inspects its manifest and
contents, and installs a fixture release into a disposable prefix. The release
build separately runs the compiled managed executable without contacting a
model provider. Together these checks verify:

- the selected distribution layout and launcher symlink;
- the static broker executable and managed systemd unit symlinks;
- that no runtime download, target-side build, Node runtime, wrapper, or
  generation tree is required;
- first-install creation of packaged administrative defaults;
- preservation of `/etc/pi-sandbox` during an ordinary upgrade;
- non-creation, non-replacement, and non-removal of the optional root-managed
  `users.d` and `groups.d` directories;
- rejection of obsolete user/group file/protocol versions and validation of
  scoped environments during broker-mode release checks;
- validated, backed-up replacement through `--replace-config`;
- compiled administrative config-path loading and its required `models_file` and
  network mode, required extension selection, and exact dynamic tool policy;
- selected-extension executable prerequisite failure;
- fail-closed missing or invalid administrative files;
- preservation of `PI_CODING_AGENT_DIR` for user state without policy or model
  redirection;
- operation from an extracted package rather than the source installer; and
- clean uninstall or replacement of the disposable prefix.

Build tests also verify strict distribution and external extension manifests,
deterministic static composition, extension inventory/provenance and hashes,
the absence of runtime extension loading, bundled Bubblewrap input digest,
architecture, version, required options, license packaging, installer mode, and
release-manifest consistency.
They verify the `pi-source.lock.json` source-archive checksum, apply
the patch series to a clean temporary Pi 1.1.0 tree, check production adapter types
against the resulting declarations, and run relevant upstream Pi tests. The contract
check verifies option keys and callback compatibility, including nested settings;
negative controls remove or alter declarations in disposable copies to prove it
fails on API drift. Behavioral guarantees remain covered by the Pi integration
tests. Release checks also prove the configured-only catalog across model types
and refreshes, build and inspect the static
Rust broker, and inspect the final Bun application and release archive. The
packaged executable diagnostic also proves that only the administrative model
catalog is exposed. Its offline RPC lifecycle checks create new sessions, resume
same-workspace transcripts, clone/fork, reject a foreign-workspace resume without
discarding the current session, and run `/sandbox` and user Bash after each
transition. They reject all extension errors, including duplicate `session_start`.
Unit tests additionally verify revoked old-runtime access, fresh session grants,
and canonical-path/alias rejection. Upstream patch tests prove rejection before
target settings/resources, before outgoing teardown, and before reload reads.
The startup-maintenance patch tests prove that the generic `beforeRun` hook is
awaited before stdin consumption, theme initialization, and each interface
runner. They verify resolved custom storage from CLI, environment, or settings,
including with `--no-session`, and omission of maintenance for metadata and
authentication exits.
The exact version-probe test requires no policy or working-directory access.
The packaged diagnostic also proves that the forced Pi Sandbox extension is the only Pi
extension. Automatic built-in factories remain disabled; managed MCP and code mode
are composed inside the forced extension only when configured. For configurable builds it selects a temporary policy with `--config`
and an invalid compiled default, proving the chosen TOML and model path appear
in diagnostics. Managed builds must reject `--config` before reading policy.
Both build modes should be exercised when changing configuration selection. A local source archive may replace the download so the entire
release test remains offline.

## Local release verification

Linux release testing runs locally with Node.js 24, Rust/Cargo 1.85 or newer,
and Bubblewrap through `npm run verify:release`. macOS release testing runs on
the target architecture with Node.js 24, Bun, and the Homebrew prerequisites;
it builds and validates the native direct-mode archive. Generated artifacts are
not committed.

If a test must skip because the developer host lacks Bubblewrap or user
namespaces, the output must explain the missing prerequisite. Release
verification treats such a skip as a failure.

## Tool logging and component inventory checks

Unit and integration coverage verifies strict parent-only logging configuration,
parent logging inheritance, selected tool filtering, target path metadata, bounded command
text, Pi-session correlation, permission decisions, and execution outcomes.
Human shell calls remain excluded. Failure tests require acknowledged intent
before execution and prove that completion-submission failures do not retry
operations. Collector tests exercise kernel peer credentials, bounded protocol
frames, structured single-line datagrams, facilities, and local-submission
acknowledgments without relying on a remote logging service.

Linux verification builds both static Rust services and validates their systemd
units and installation lifecycle. Release checks apply the pinned-source patch
that disables session sharing and test that the share operation is not invoked.
SBOM tests check component discovery against bundle inputs and copied assets;
release archive inspection verifies the generated inventory is checksummed and
shipped with the matching application.

## Managed MCP and code mode

Offline fixtures verify administrator-only configuration, credential projection,
path/environment account macros and literal URL query preservation, original-name wildcard policies, bounded
approvals, exact grants, stale-catalog revocation, tool narrowing and session
cleanup. Activation tests cover merged Pi settings, additive and wildcard CLI selection,
registration ceilings, effective TOML disablement, `--no-mcp`,
MCP autoactivation, and stock `on`/`only` presentation. Preference/menu fixtures
verify persistence, immutable managed connections, unavailable servers, save failures,
and revocation on disable/exposure changes. HTTP and stdio transports share policy tests. Patched-source tests cover
bounded HTTP JSON/error/SSE reads, stdio process-group cleanup, inline results,
code VM source/call/output limits, deadlines and awaited nested cancellation.
The packaged fixture exercises the compiled application with a local scripted
provider and local MCP servers; it never contacts a live model provider. Project
`.env` files must not redirect session storage through Bun environment autoload.

## smolvm qualification

Managed unit checks cover schema 11 image/resource validation, fixed VM lifetime,
identity backend transitions, refusal of identity image overrides, VM-aware
mount/policy diagnostics and the `smolvm` audit boundary. Distribution checks
cover the optional fixed external 1.25.4 provider without requiring an installed
runtime during cross-build/staged validation. Real VM tests must additionally
use a verified full runtime and trusted tools image on Linux x86-64 with KVM;
ordinary host-only tests are not evidence of VM confinement or cleanup.

Set `PI_SANDBOX_SMOLVM_BIN` to the official distribution's wrapper,
`PI_SANDBOX_SMOLVM_IMAGE` and `PI_SANDBOX_SMOLVM_IMAGE_SHA256` to a trusted packed
tools image, and `PI_SANDBOX_SMOLVM_OCI_IMAGE` and `PI_SANDBOX_SMOLVM_OCI_SHA256`
to a local OCI tools archive. `PI_SANDBOX_REQUIRE_SMOLVM=1` makes missing native
prerequisites fail instead of skipping. The release verifier uses these inputs
for owned project execution, OCI families and the standard Pi package.

The native cases cover RW/RO project access, binary streaming, persistent guest
processes, cancellation, timeout, output overflow and close; frozen OCI sources,
independently writable siblings, branchable implementers, authenticated borrowed
attachments and repeated cold reopening. Package tests launch ordinary Pi from
the extracted tarball and check that borrowed shutdown leaves ownership with the
controller. No live provider is used. Abrupt owner death remains a documented
manual-recovery case, not a tested automatic-cleanup guarantee.

For the compiled managed application, run the following against an extracted
Linux x86-64 review build with `allow_config_override = true`, the Git extension
included, and its build-selected external smolvm distribution available:

```sh
PI_SANDBOX_SMOLVM_IMAGE=/absolute/path/tools.smolmachine \
PI_SANDBOX_SMOLVM_IMAGE_SHA256=REPLACE_WITH_IMAGE_SHA256 \
node scripts/test/smolvm-managed-smoke.mjs \
  /absolute/path/pi-sandbox /absolute/path/defaults
```

`build:release` also runs this fixture automatically for such a review build
when `PI_SANDBOX_SMOLVM_IMAGE` is set or `PI_SANDBOX_REQUIRE_SMOLVM=1`.

This fixture exercises RPC conversation replacement, persistent guest processes,
host-project writeback, unmounted host-file isolation and VMM death on normal
EOF. It also checks approved host `git_clone` over loopback HTTP followed by
guest readback, then reuses the full managed MCP/Code Mode smoke suite with
scripted loopback providers. No live model is called. VM state and project files
use short private `/var/tmp` paths; one disposable Pi state directory under the
invoking account's home lets the existing stdio account-identity checks run
without changing host account records. The fixture removes its directories on
confirmed cleanup and preserves them with reported paths after uncertain cleanup.
