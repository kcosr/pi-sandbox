# Testing

## Reusable extension acceptance

Shared package unit tests run with `npm run test:unit`. `npm run test:extension`
builds and inspects both tarballs, checks their emitted JS/declaration imports,
and starts stock Pi 1.3.0 against independently extracted artifacts. Sandbox is
installed without Git or permissions; Git is installed alone and with sandbox.
No workspace package links are admitted. Provenance includes Git's bundled runner.

To exercise a bundle-bearing artifact, run each package script with the same
build input:

```sh
node scripts/test/sandbox-extension-package.mjs --distribution /path/to/distribution.toml
node scripts/test/git-extension-package.mjs --distribution /path/to/distribution.toml
```

`verify:release -- --distribution FILE` propagates that selection to both
package tests and the managed release. It supplies the verified directory to
native test fixtures through test-only `PI_SANDBOX_TEST_TOOL_BUNDLE`; product
runtime code does not read this variable. Package paths must be outside writable
workspaces, and Node/Bun acceptance must test the extracted package.

Linux sandbox acceptance requires Bubblewrap, Node 24 and Bun 1.3.14+ and checks
both worker runtimes, conversation replacement and persistent background jobs.
Direct acceptance also exercises ordinary and nested parallel tool calls.
Git acceptance uses local HTTP repositories and scripted local model responses
for ordinary/nested Code Mode cloning, restrictions, exclusions and repeated
sessions. Both extension load orders run with direct execution on Linux and
macOS, with Seatbelt on macOS, and with Bubblewrap on Linux. Temporary paths are canonicalized before
configuring the workspace. Managed tests cover mandatory approvals, exact canonical snapshots,
per-call cancellation, audit failure, MCP and nested Code Mode. No live provider
is contacted. Standalone direct acceptance runs stock Pi under Node and Bun
without requiring Bubblewrap and preserves output, cancellation and tool rendering.

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
env -u NODE_ENV npm run verify:release -- --pi-source-archive /path/to/pi-1.3.0-source.tar.gz
```

The verifier runs formatting, lint, type checking, Rust service checks, unit,
integration, real-Bubblewrap, package/install, build, archive inspection, and
packaged executable diagnostic checks as distinct observable steps. A supported release
host must execute the Bubblewrap suites rather than accepting a skip caused by
unavailable namespaces.

`build:release` is the separate build/package/integrity entry point. It does
not run behavioral tests. Both workflows check source pins, configuration,
manifest/SBOM inventory, package layout and checksums. The verifier always
supplies the builder's two verification checkpoints: patched-source API/negative
controls plus upstream/theme suites, and the platform's packaged executable
checks. No test list was removed or made opt-in by this separation.
`scripts/test/release-workflow.mjs` checks import/CLI behavior, failure cleanup,
verification environment propagation, platform selection and fixture isolation.
Temporary packaged-smoke TOML disables both identity and audit dependencies
while retaining their other fields; the shipped policy is untouched. Service
protocol, fail-closed audit and broker behavior retain their dedicated suites.

On macOS the verifier requires real Seatbelt controls and both Node/Bun runtime
fixtures. It selects Bun from `PI_SANDBOX_TEST_BUN`, `PI_SANDBOX_BUN`, or the
test host's `PATH`, in that order; use the verified release toolchain. Genuine
documented GNU prerequisites or the distribution's verified tool bundle are
required for direct and Seatbelt tests.

Linux real-Bubblewrap tests also require Python 3 for offline socket-family and
namespace probes. This is a test-host dependency, not an application runtime
dependency.

## Test layers

### Unit

- strict versioned TOML parsing;
- compiled extension catalog, manifest, schema, identifier, and collision
  validation;
- required extension selection and exact dynamic model-tool policy sets;
- strict `none`, `local`, and `host` network modes, and optional administrator command timeout caps;
- execution-backend overrides, `none < local < host` joins, omission inheritance,
  preservation of the base command timeout maximum, and rejection of removed lifetime fields;
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
- bounded MCP user/group approval layers and separate enabled flags, per-file
  first-match/default resolution, complete-pair joins before main defaults,
  Unicode pattern parity, canonical whole-layer deduplication, global audit
  preservation, strict authored/wire versions and pre-write response bounds,
  unknown matching server rejection, effective code-mode dependency validation,
  and disabled-server credential, executable and transport suppression despite
  saved user enablement preferences;
- direct-argv host execution, per-extension declared environment admission,
  cross-extension and Pi-variable isolation, inherited-variable removal and
  fixed overlays, bounds, process-group cleanup, and fixed launch CWD;
- Git locator parsing, exact scheme/host admission, safe derived destination,
  and rejection of options, local transports, bad basenames, and arbitrary
  targets;
- standard Pi tool-only factory capture, declaration matching, and policy wrapping;
- command/input/output/time limits and cancellation; and
- exact dynamic tool-catalog construction.

File-backed Pi environment tests cover strict authored `{file}` versus wire
`{literal}` parsing, Pi-only admission, literal preservation including BOM and
macro-looking bytes, LF/CRLF handling, empty/NUL/UTF-8 and byte limits, regular-file
checks, ordinary symlink/permission behavior, and path-free failure messages.
Runtime tests cover broker overlay before base reads, matching-only broker
reads, conflict checks before I/O, per-request snapshots and fresh subsequent
reads, post-resolution aggregate limits, symbolic installation validation,
explicit MCP mapping and unchanged sandbox/extension environment isolation.

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

### Real Seatbelt (macOS)

Run native acceptance on each intended macOS architecture; an arm64 pass does
not qualify x86-64. Exercise both the managed compiled Bun application and the
independently packed standalone extension with stock Pi under Node and Bun.
Keep tests offline with local scripted model responses and local socket fixtures.
Require native prerequisites instead of silently accepting skips:

```sh
PI_SANDBOX_REQUIRE_SEATBELT=1 PI_SANDBOX_TEST_BUN=/absolute/path/to/verified/bun \
  npm test -- packages/sandbox-extension/src/runtime/seatbelt-executor.test.ts \
  tests/integration/seatbelt-tool-flow.test.ts
```

The compiled review-build smoke uses a release explicitly built with
`allow_config_override = true`; ordinary managed releases keep that setting false:

```sh
node scripts/test/seatbelt-packaged-smoke.mjs /absolute/path/to/review/pi-sandbox
```

This smoke exercises the installed compiled application, RPC/session replacement,
managed approvals and MCP/Code Mode against local fixtures. Independently packed
standard-extension acceptance remains `npm run test:extension`.

Verify all seven tools, user `!`, canonical CWD, read-only and writable CWD,
ordinary outside reads with denied writes, real host scratch, and existing
canonical directory denials. Reject unsupported `local`, removed lifetime fields,
nonempty hidden paths, missing/symlink/file denials, contradictory grants and
unknown launcher fields. Verify none/host networking, no direct fallback, bounded
input/output, concurrent execution, cancellation and close, and accurate diagnostics.

Scheduling does not exclude surviving descendants. Include an explicit
residual-risk test demonstrating that background descendants may outlive ordinary
foreground completion with their original grants. Cancellation/close cleanup
attempts apply only while the direct child remains active. Test fixtures must
reap their own intentional survivors without adding a production observer or
service. Re-run Linux Bubblewrap/direct checks when shared code changes.

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
- more than four and more than 64 lightweight commands can overlap with independent
  input, output and results; no fixed active/outstanding count rejection;
- pre-launch cancellation prevents execution; active cancellation, timeout,
  overflow, callback/spawn failure preserve peers;
- result/start/retirement races cannot settle twice or affect another request;
- optional timeout starts at successful launch, excludes approval/file/transport
  waits, and remains authoritative through drain;
- quiet uncapped commands do not trigger transport watchdogs, and backpressure
  keeps cancel/close responsive at complete-frame boundaries;
- host pseudo-filesystems and privileged sockets are not exposed;
- TCP and pathname Unix-socket attempts inside and outside the writable CWD
  fail in offline mode;
- host mode reaches a host-loopback listener;
- local mode permits IPv4/IPv6 TCP/UDP loopback while host listeners, named Unix
  sockets and external routes remain unavailable;
- datagram socket pairs cannot reconnect to host sockets in `none` or `local`,
  with a host-mode positive control; Bun stream-pair child spawning still works;
- a server started in one call is reachable with curl from another under local
  networking, without a lifecycle mode switch;
- post-exit output restarts the 100 ms idle timer; silent inherited pipes release
  the call, completed output cannot corrupt later calls, and timeout/output bounds
  still apply to continuously arriving output;
- individual failures do not remove peer/background servers; final Linux namespace
  shutdown removes remaining descendants, including detached processes;
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
tests and native release validation require the declared Homebrew GNU tools or
the selected, pinned native tool bundle;
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
the patch series to a clean temporary Pi 1.3.0 tree, check production adapter types
against the resulting declarations, and run relevant upstream Pi tests. The contract
check verifies option keys and callback compatibility, including nested settings;
negative controls remove or alter declarations in disposable copies to prove it
fails on API drift. Behavioral guarantees remain covered by the Pi integration
tests. Pi 1.3 regressions cover late worker startup, cancellation with pending
nested cleanup, worker-capacity recovery only after actual exit, resumed tool
selection, ambiguous configured model IDs, raw read-range arguments, and disabled
sharing for every destination. Real Node/Bun worker fixtures observe process exit
from their parent because Bun may omit the child's exit callback.
Release checks also prove the configured-only catalog across model types
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
the target architecture with Node.js 24, Bun, and the system prerequisites or
selected native tool bundle. It builds and validates the native archive with
Seatbelt selected by default and qualifies both Seatbelt and explicit direct
execution. Generated artifacts are not committed.

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

Machine-ID controls cover symbolic installation validation, expansion after
broker merging, one shared lazy lookup across scopes and MCP, environment
precedence, unsupported/failed lookup and server-local stdio failure. Reader
fixtures check fixed executable/arguments, cleared environment, output/deadline
bounds and strict UUID parsing without committing a real machine identifier.
Native macOS package acceptance must verify host lookup under Node, Bun and
the compiled application without making live provider requests. Literal URLs,
HTTP headers and credential references must remain unexpanded.

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

## Bash command analysis

Analyzer unit tests cover the recognizer, the option engine, every registry
profile with accepted and rejected forms, issue ordering and printable-ASCII
messages, and the execution-context checks with an injected filesystem probe:
`BASH_ENV`, `SHELLOPTS`, `BASHOPTS` and `EXECIGNORE`; `LD_*`, `DYLD_*` and
`GCONV_PATH`, including look-alike names that must not match; non-ASCII input
under C, UTF-8 and other locales; every exported-function form and an exported
`command_not_found_handle`; missing, empty, relative and launch-directory `PATH`
entries, including symlinked entries; missing or non-regular executables;
executables resolving into the launch directory; resolution shared within one
analysis; and `RIPGREP_CONFIG_PATH` and `GREP_OPTIONS`. A known-bypass corpus
must stay unclassified, including brace and glob words (`rg --pre{=,=sh}`,
`find . -de\lete`), line continuation, ANSI-C quoting, `${x@P}`, arithmetic
substitution, assignment prefixes (`PAGER=curl …`), reserved words, GNU
abbreviations (`sort --compress=sh`), `uniq a b` and `uniq a -c`, `sed …e`,
`/dev/tcp` input, descriptors above 2, `&>>`, background `&` and multi-line
pipelines. Recognizer tests additionally reject control characters inside
quotes, invalid Unicode and repeated-slash `/dev/tcp` spellings.

Version 2 additionally tests double-quote escape parity and retained backslashes,
source offsets and quoted descriptor digits, symbolic `cd` prefix grammar, the
mandatory literal-argument gate for every other profile, complete sed program
consumption, and exact integer sleep bounds. Huge sleep values are analyzed
only. File writes, active substitutions, option smuggling, symbolic redirect
targets and environment/function overrides remain negative controls.

The differential integration test
`tests/integration/bash-known-read-only-differential.test.ts` runs every accepted
corpus entry under the real `/bin/bash` with POSIX `sh` stub executables on an
isolated `PATH`. Each stub records its argv, the file type of descriptors 0–2
and every marker it reads from standard input, and writes a unique marker to
standard output and standard error; standard input and input files carry their
own markers. The test predicts from the parse which stages run, their argv and
descriptor types, and where every marker must arrive: a capture file, the stage
reading a pipe, or nowhere for `/dev/null`. This checks stage wiring, capture
routing, discards and duplication in source order without device or inode
numbers, so it runs unchanged on Linux and macOS. It also checks every accepted
input of a seeded generated corpus, and that deliberately wrong predictions
fail. It skips only when `/bin/bash`, `/usr/bin/mktemp`, `/bin/cat` or `/bin/mv`
is missing.

Each stub uses the test runner's Node executable to inspect inherited descriptors
with `fstat`, without redirecting the probe's own streams. On macOS, path-based
`/dev/fd` inspection can intermittently return an incorrect type or `EBADF` for
a live pipe. Direct inspection preserves exact descriptor checks and marker
routing assertions. The generated corpus has a five-minute harness budget to
accommodate per-stage Node startup on slower hosts; its 4,000 inputs and the
ten-second per-command limit are unchanged.

The curated and generated differential corpora include the version 2 forms,
escaped redirect targets, `cd` success/failure branches and pipeline directory
isolation. Deliberately wrong argv and directory predictions must fail.
`tests/integration/bash-read-only-native.test.ts` also runs the actual `cd`
builtin with HOME containing spaces, glob characters, shell-looking text,
leading dashes, empty and unset values. Expected directory and relative-file
results are independent of the production analyzer; marker files must not be
created by HOME contents. Actual sed runs compare synthetic range output with
fixed expected text for every admitted escape shape, and actual sleep runs use
only zero and one second.

`src/permissions/known-read-only-docs.test.ts` fails when the generated command
table in [configuration](configuration.md#known-read-only-command-registry)
differs from the registry, and when Prettier would change the generated block.
Regenerate the table with:

```sh
PI_SANDBOX_UPDATE_DOCS=1 npx vitest run src/permissions/known-read-only-docs.test.ts
```

The real-Bubblewrap end-to-end suite runs the real analyzer, constructed as the
managed runtime does, through the managed extension: with main `deny` and class
`allow`, `ls | head` runs without a prompt and `touch x` is denied with
not-a-known-read-only feedback; with main `ask` and class `ask`/`offer`, a
class-scoped session grant covers later known read-only commands but not an
unclassified command.
Both policies exercise escaped grep patterns, sed regex ranges, sleep and
`cd ~/`; the latter must use Bubblewrap's private HOME. Native Seatbelt tests
exercise its actual scratch HOME without resolving it during classification.

Managed integration tests prove:

- strict parsing of `[tools.bash.known_read_only]`, rejection under other tools,
  every validation rule and its message, and the read-tool precondition on both
  the base policy and the effective policy after broker overrides;
- strict broker-response parsing, rejection of unnormalized class policies, and
  wholesale Bash replacement including an absent class policy;
- the join, request binding of the class into the frozen fingerprint, scoped
  session grants, revisions that include class policies, and prompt labels;
- analysis of the exact executed snapshot, including nested code-mode Bash
  calls, no analysis without a class policy or for user `!`, fail-closed
  handling of analyzer exceptions and malformed results, denial feedback bounded
  to 512 bytes, and startup refusal without an analyzer;
- per-backend execution contexts that match the environments the executors
  construct;
- paired audit fields only on Bash decision events, with versions bounded to the
  collector's range; and
- `/sandbox policy` class rows, grants, registry version and command names,
  with output unchanged when no class policy is configured.

Broker tests cover per-file class validation, the class join across matching
rules, and normalization for every main and class combination. Collector tests
accept and forward the paired fields on Bash decision events and reject
unpaired, misplaced, non-Bash, zero or out-of-range values.

Version 2's analyzer and native utility tests passed on macOS 15.7.4 x86_64
with stock Bash 3.2.57 and system sed/sleep. The historical evidence below
qualifies version 1. A first native run on macOS
26.7.1 with `/bin/bash` 3.2.57 passed the analyzer unit tests and probed every
registry option spelling (946 generic and 164 `find` cases) against the
utilities resolved by both the packaged Seatbelt system `PATH` and the selected
tool-bundle prefix, without finding an accepted option that writes files, runs
programs or locks. Its differential run
failed only in the earlier identity-based harness: `/dev/fd` reports a synthetic
device, and the two ends of a pipe report different inodes. The portable
marker-based harness above replaces it and passed natively at `1750997`,
including every accepted input of the seeded generated corpus. Stubs write each
marker in its own subshell, because Bash 3.2 `printf` otherwise keeps a failed
broken-pipe write buffered and later flushes it to standard error. The
Apple `cat` Unix-domain socket fallback is recorded as a residual risk in
[security](security.md#parser-and-shell-differentials).

### Administrator command sets

Require strict main-only config tests for field names, IDs, executable/builtin
separation, exact flags, enumerated values, operand ranges and all size bounds.
Cover strict `{ any_literal = true }` tables, rejection of false/scalar/extra-key
forms, exact literal `"*"`/`"string"` enum values, and deeply frozen tagged predicates.
Cover string/list alternatives, duplicate and malformed paths, exact decoded
spelling without inferred aliases, quoted path spaces, and absolute builtin-named
files requiring actual executable checks. Explicit paths bypass PATH lookup while
retaining shell, loader, known-program environment and namespace-placement checks.
Matcher controls cover omitted, repeated, abbreviated, clustered, attached and
misordered options; option-like operands; literal quoting and unsupported shell
expansions. Preserve context/environment gates, including those for custom forms
of known registry commands.
Repeated value-taking options must validate every occurrence, while duplicate
zero-value flags still fail. Test empty values, dash-leading values, `--` consumed
as data, missing final values, long equals forms, tilde/variable/substitution/glob
fallback, and the whole-command bound without a per-literal 256-byte cap. A consumed
value spelling an environment-bypass flag must not count as that flag.

Policy and managed-extension tests must cover custom-only and mixed pipelines,
whole-call fallback before dispatch, effective built-in allow requirements, deny
exceptions and disabled precedence. Confirm no custom session grant, ordinary
fallback prompt wording, deep-frozen rule/stage snapshots and fingerprint v3.
Option predicate changes must invalidate grants; option data must not enter stage
coverage. Diagnostics show authored enum/any-literal forms rather than internal tags.
Direct evidence tests exercise the 256-stage/64-ID bounds, malformed or duplicate
IDs, missing custom matches, and oversized-result fallback to ordinary policy.
Broker tests retain main definitions across overrides and reject command-set
definitions in rule/wire inputs. Audit client and collector tests require wire 3,
record schema 4, separate configured-command IDs and strict older-wire rejection.

`tests/integration/bash-command-sets.test.ts` compares real Bash argv and pipeline
behavior with the declared shapes using an owned offline executable; injection
controls must leave sentinel paths absent. The real Bubblewrap cases in
`tests/e2e/fake-pi-tool-flow.test.ts` qualify a custom executable, mixed built-in
coverage, pre-dispatch fallback and disabled-tool omission. These controls do not
certify arbitrary administrator-selected utilities as read-only.

PATH-prepend tests must cover main-only admission, syntax-only installation,
ordered canonical snapshots, canonical duplicate/missing/non-directory failures,
writable-CWD and private/hidden/denied placement, and rebinding before startup.
Verify bundle-first precedence and identical executor/analyzer environments for
all backends. Real Bubblewrap coverage must invoke a configured helper through
both basename and absolute path and retain fixed typed-tool executable selection.
Ordinary package checks must preserve omitted-option behavior and reject the
managed-only setting in standalone JSON.
