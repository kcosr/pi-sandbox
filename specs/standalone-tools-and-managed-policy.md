# Standalone sandbox and Git, with managed permissions

Status: implemented on `feat/standalone-tool-extensions` from main at `f821ca9`,
after merging the Bubblewrap and smolvm concurrency changes. The design was
reviewed against `feat/separate-permissions` at `98faae2`. This replaces the earlier standalone-permissions
and standard-extension-framework proposals, and the sandbox-only scope draft.

## Decision and scope

Publish two ordinary Pi extensions: sandbox and Git. Each has a standard Pi
entry point and a programmatic interface. Pi Sandbox uses application-owned
adapters to configure those interfaces from administrator TOML and enforce its
internal permissions, approvals and audit requirements.

Do not publish a permissions extension. Do not introduce a shared coordination
or contracts package. The application owns authorization directly; the standalone
extensions do not discover or negotiate with a permission provider.

The sandbox remains independently usable by the evaluator, which supplies its
own tool admission and does not need the managed permission engine or UI.
Arbitrary third-party extension loading in Pi Sandbox remains future work.

## Ownership and dependencies

```text
ordinary Pi ──> sandbox entry ──> sandbox tools and backends
            └─> Git entry ─────> Git clone implementation

evaluator ────> sandbox factory/runtime

Pi Sandbox ───> TOML, broker, internal permissions and audit
            ├─> sandbox adapter ──> sandbox factory/runtime
            ├─> Git adapter ──────> Git clone implementation
            └─> existing managed MCP and Code Mode integration
```

| Component                      | Owns                                                                                                        | Must not depend on                                            |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `packages/sandbox-extension`   | Seven built-in tool replacements, execution configuration, backends, lifecycle, neutral invocation types    | Permissions engine/UI, managed app, Git package               |
| `packages/git-extension` (new) | Clone validation and execution, repository config, normal Pi registration, standalone host-runner lifecycle | Permissions engine/UI, managed app, installed sandbox package |
| Managed application            | TOML, broker, tool admission, approvals/grants, audit, managed adapters, MCP                                | Standalone entry-point side effects                           |

The managed adapters may use the packages' parsers and types, but neither public
package reads the application's TOML or imports its private SDK. The application
does not load their standalone entries, flags or standalone config files.
Shared source within this repository is allowed; independently installed
artifacts must contain all their runtime code except declared ordinary peers.

## Sandbox package

### Explicit authorization boundary

Retain the existing `createSandboxExtension` factory and its required, awaited
`authorize` callback. Replace the permission engine's branded `ApprovalRequest`
with a sandbox-owned neutral request:

```ts
interface SandboxToolRequest {
  readonly subject: BuiltInToolName;
  readonly arguments: JsonObject;
}

authorize(
  request: SandboxToolRequest,
  context: ExtensionContext,
  signal?: AbortSignal,
): Promise<void>;
```

The sandbox tool resolves paths and Bash CWD against its executor, then creates
a detached, deeply frozen argument snapshot and freezes the outer request too.
Preserve today's canonical JSON round-trip semantics: reject cycles, non-finite
numbers, non-JSON values and object prototypes other than `Object.prototype` or
null; sort object keys, serialize, parse with `JSON.parse`, then deep-freeze.
An own `__proto__` key must remain an ordinary data property; do not copy through
property assignment that invokes prototype setters. JSON normalization, such as
`-0` becoming `0`, must happen before authorization as well as execution.
The managed policy uses the same pure canonicalization helper, so preparing its
private approval copy cannot change the already-normalized argument values.

It passes that snapshot and the actual invocation signal to the callback,
awaits success, checks cancellation,
and executes from the same snapshot. The callback cannot replace arguments.
Missing/failed authorization must never imply permission. Reject a missing or
non-function callback when constructing the factory, including JavaScript use.

The immutable factory `tools` list remains the registration ceiling. Preserve
existing Pi tool activation/exclusion behavior and managed CLI restrictions.
`userBash` remains a separate choice, including preventing host-shell fallback
when disabled. No changes to executor/controller signatures, owned/attached VM
contracts, queues, process lifetime, output drain, cancellation or shutdown.

In Pi Sandbox, the callback prepares an internal approval request from the
snapshot, creates the preview, evaluates policy, awaits the decision audit, and
rejects denial or cancellation. Its private branding/fingerprint belongs to the
same managed policy implementation that verifies it. A policy-internal copy
must preserve exactly the values that the sandbox executes. No permission
brand crosses the package boundary, and there is exactly one authorization
decision for each operation, including nested Code Mode operations.

The standalone entry supplies an explicit no-op authorization callback after
its existing readiness checks. The evaluator supplies its own callback, or an
explicit no-op behind its fixed tool ceiling. Neither path initializes the
managed permission engine.

### Standalone configuration and packaging

Remove provider discovery, tool delegation, provider initialization/teardown,
and the `requirePermissions` switch. Accept a single new standalone JSON schema
version, version 4, with `version`, `mode`, `userBash`, and either `backend` or
`attachment`. Preserve the current backend/attachment fields and validation.
Reject old versions and obsolete fields; add no compatibility parser.

Retain `--sandbox-config`, explicit private config-file ownership/mode/size
checks, canonical CWD, worker probes, process-owned executor reuse across logical
sessions, and quit/reload cleanup. Startup failure remains fail-closed.

Move built-in names, JSON types and pure snapshot helpers into the sandbox
package. The managed domain imports/re-exports the sandbox's built-in names;
keep one canonical list, not a second declaration. Managed request preparation
and verification reuse the pure canonicalizer. Keep preview formatting, grants,
policy modes, approval UI and branded
approval requests inside the application. Remove every runtime and type import
of `@kcosr/pi-permissions-extension` from sandbox source and emitted artifacts.

## Internal managed permissions

Move the existing policy implementation into `src/permissions/`, distinct from
the configuration types in `src/domain/policy.ts`, preserving its tests and
behavior. Remove
`packages/permissions-extension`, its standalone JSON/flags, event-bus
coordination protocol and its build/pack/install targets. Update references
deliberately rather than reverting the extraction commit wholesale.

Preserve allow/ask/deny/disabled behavior, per-subject session-grant choices,
policy-revision invalidation, no-UI behavior, and memory-only session grants.
Preserve readiness checks, actual per-call cancellation and audit-failure
ordering. Do not change the scope of grants to argument-specific permissions.

Managed MCP admission, original-tool wildcard policies, typed catalog revisions,
credentials, dispatch checks and nested approvals stay intact. Current controlled
extension loading stays intact. This design needs no new Pi hook-order patch.

## Git package

### Preserve the clone contract

Expose only `git_clone({ repository })`, with the existing schema, fixed argument
vector, exact repository host/scheme allowlists and `sequential` declaration.
Use the existing repository parser and basename rules. Do not add fetch/pull,
arbitrary Git commands, arbitrary destination selection or custom Git options.

Clone runs on the host through the bounded host-command executor. It derives an
immediate child of the captured canonical launch directory, removes a trailing
`.git` from the repository basename, and rejects any existing destination,
including empty directories and symlinks. For example:

```text
launch CWD: /home/user/work
repository: https://github.com/example/widget.git
destination: /home/user/work/widget
```

Bubblewrap and managed smolvm share that launch directory at the identical path;
there is no second guest destination or copy step. Standalone Git also works
without a sandbox. When combined with an externally attached VM, visibility
depends on the owner's mounts: Git does not discover attachments, copy into a
guest-only workspace, or promise that arbitrary attached guest paths exist on
the host.

Preserve absolute `/usr/bin/git` and `/usr/bin/ssh`, scheme restrictions,
environment sanitization, disabled global/system Git config and disabled
interactive prompting. Git remains a host operation, outside sandbox filesystem
and network policy. Read-only sandbox CWD does not prevent the host clone;
subsequent sandbox access follows its mount policy.

Retain the accepted destination-validation race and the nested Code Mode
sequencing limitation documented in `docs/security.md`. Scheduling alone cannot
exclude surviving background writers. Add no clone-specific termination,
staging, publication helper, guardian or scheduler. Existing host-command process
group cleanup remains unchanged.

### Core and two adapters

The package owns the repository/config parsers, tool metadata/schema, destination
derivation, prerequisite list, environment restrictions, clone operation and
bounded call-summary formatting. Expose only the small programmatic surface
needed by its two consumers; keep types structural and package-owned.

The clone operation receives validated configuration, canonical CWD, immutable
repository arguments, the invocation signal, and a narrow host `execute` port.
It must not import the managed SDK or silently spawn a process when that port
is absent. The port accepts the fixed executable/argv and returns bounded output
and exit status; cancellation is passed through. Ownership/close is separate.

The standard Pi factory registers a normal tool and uses that operation. The
programmatic factory borrows its injected execution port and never closes the
caller's resources; only the standalone entry owns a runner. The
managed adapter at `src/managed-extensions/git-clone` keeps its current
`kind = "managed"`, API version 3 and compiled identity `git`. It delegates
parsing/metadata/execution to the public package, retaining the existing managed
wrapper as the single permission/audit gate. That wrapper freezes arguments
before approval and passes the same approved values to the core. Preserve the
repository and derived-path audit selector and the bounded repository tool card.
The managed lifecycle owns its host executor and scoped environment.

The adapters need not have identical callback signatures: sandbox already has
an authorization callback; Git already has an application-owned wrapper. Keep
those small seams instead of designing a general extension-composition API.
The public Git package can provide `.` for the normal entry and separate
`./factory`, `./core` and `./config` exports without a proprietary descriptor.
Only the managed adapter has our descriptor.

No managed TOML or descriptor schema change is required. Keep
`[extensions.git]`, `[tools.git_clone]`, existing environment scoping and build
selection. Their generic validation and broker policy merging remain in use.
Update version/provenance metadata for changed artifacts; do not bump unrelated
manifest/API schemas.

### Standalone Git configuration and lifecycle

Require an explicit `--git-config /absolute/path.json`. Use a strict version 1
JSON object with the same repository-policy keys as the managed parser:

```json
{
  "version": 1,
  "allowed_hosts": ["github.com"],
  "allowed_schemes": ["https", "ssh"]
}
```

Reject missing/unknown fields and invalid values using the same core validators;
do not default to unrestricted hosts. Follow the existing standalone sandbox
file discipline: user-owned regular file, private permissions, no final symlink,
bounded read, explicit absolute path, and no automatic project config discovery.
The JSON wrapper strips only its own version before calling the shared parser.
No approvals or managed TOML fields belong in this file.

Capture the canonical initial CWD, validate prerequisites and configuration
before permitting execution, and keep configuration/CWD stable for the entry's
lifetime. Register the tool in time for ordinary Pi tool selection; execution
must reject until initialization succeeds and after shutdown. Initialization
must tolerate repeated session binding. Do not activate a tool the user excluded.

Standalone Git owns its host executor, captures and sanitizes the host environment
once, and supplies it explicitly. Apply the same Git restrictions as managed
execution. The managed adapter continues using its own resolved scoped environment;
it must not inherit the standalone environment or JSON configuration. Keep the
current absence of Git-specific scoped variable declarations.

Close the standalone executor on extension/session teardown, startup failure,
reload and quit; abort running clones with bounded existing process-group
cleanup. Logical session replacement may recreate the cheap executor; no Git
background process or process-wide owner needs to survive it. Managed execution
uses the existing application cleanup owner. No extra watcher or daemon.

### Reuse the bounded host runner without a new package

The existing Node-only host-command runner is also used by sandbox direct and
smolvm execution. Keep one canonical implementation and its tests. At build time,
bundle its required code into the Git artifact as private implementation code;
leave sandbox's existing use intact. Do not maintain a handwritten second runner,
move general execution ownership into Git, or add a runtime sandbox dependency.

This is source reuse during the repository build, not a shared coordination
library that users must install. The Git tarball must contain the bundled runner;
its JS and declarations must not point back to the sandbox checkout. Export only
Git-owned structural interfaces. Include all bundled source inputs in Git's
provenance hash and artifact inventory, not just `packages/git-extension/src`.

Use the existing build toolchain's bundler for the Git entry, externalizing only
Node built-ins and declared Pi peers. Handle Git declarations separately with
temporary repository-root staging, retaining only a self-contained public
declaration graph. Sandbox keeps its package-local TypeScript output.
Check all emitted imports rather than trusting workspace resolution. Do not
rely on class or private-symbol identity across the artifact-local runner copies.

## Ordinary Pi and future integrations

Both public packages load through stock Pi's extension API without managed
patches, a sibling checkout or the other package. Sandbox replaces the seven
built-ins and optionally handles user shell; Git adds only `git_clone`.

Document pinned Pi's conflict behavior: the first extension in runner order
providing a duplicate tool name wins; user-shell handling stops at the first
handler that handles it. Load sandbox before competing built-in/shell handlers.
Sandbox and Git have disjoint tool names and need no coordination protocol.
Their presence does not sandbox arbitrary extension JavaScript or add our
approval system to vanilla Pi.
State this distinction explicitly in the maintained security documentation:
standalone sandbox provides its configured execution boundary, and standalone
Git provides repository/argument restrictions; our approval prompts exist only
in the managed application.

The upcoming service can use the existing `[mcp.servers.<id>]` HTTP/stdio path
if its transport/authentication fit. Existing per-server defaults, original-name
wildcards and nested approvals apply; browser OAuth remains unsupported.

Future arbitrary managed extension loading is separate. Normal Pi compatibility
should not inherently require our descriptor or TOML hooks. The host would need
admission, final authorization after ordinary hooks, approved-argument dispatch,
and protection of sandbox tool/shell ownership. Extensions remain trusted host
code. Record these considerations without implementing that loader, a generic
configuration bus, a new final-hook patch or arbitrary-tool permission product.
The existing managed/`pi-tool` composition kinds and their current surfaces
remain deliberately unchanged. Update AGENTS to describe this retained design,
not the abandoned descriptor-unification proposal.

## Implementation sequence and verification

1. Move policy back inside the application and replace sandbox's branded callback
   payload with its neutral immutable request. Remove provider negotiation and
   standalone permissions packaging/config; update sandbox schema and docs.
2. Extract Git's single core implementation, retain the thin managed descriptor,
   and add the standard entry/config/lifecycle. Bundle the existing host runner
   into the independent Git artifact.
3. Update workspace dependencies/lockfile, build/pack scripts, artifact checks,
   release version tables, AGENTS invariants, and applicable maintained docs.
   Preserve all stacked backend work. No compatibility aliases or duplicate
   permission engines. Keep changelog entries concise when implementation lands.
4. Qualify each isolated tarball with stock pinned Pi: sandbox alone, Git alone,
   and both together. Install without workspace links, permissions package or
   sibling checkout. Inspect exports, emitted JS/declarations, worker/runner
   contents, provenance and checksums. Do not publish artifacts in this task.
5. Regress managed allow/ask/deny/disabled, grants, every-call authorization,
   immutable approved/executed values, real signal identity, cancellation while
   awaiting approval, audit failures, MCP and nested Code Mode, Git allowlists,
   environment, fixed argv, destination validation and failure cleanup. Exercise
   tool exclusion, duplicate registration and bounded renderers through Pi.
   Cover `__proto__` keys, JSON normalization (including `-0`), invalid/cyclic
   inputs and exact approved/executed value equality at the snapshot boundary.
   Test repeated session binding, logical replacement and reload: preserve tool
   exclusions, replace closed Git runners and close a runner created before
   asynchronous startup fails.
6. Keep all tests offline: use an injected host port for deterministic Git core
   tests and a local test HTTP Git server for actual clone coverage. Verify host
   destination and guest visibility with managed Bubblewrap/smolvm, without
   claiming visibility into an arbitrary attached guest. Preserve evaluator
   owned/attached contracts and concurrency/cancellation/shutdown checks.
   Run applicable checks from `docs/testing.md`, including package/build/install
   smoke tests and native backend qualification, before implementation release.

## Review record

Two read-only subagents checked the sandbox/managed and Git boundaries against
the baseline and reviewed this draft, with no blocking architectural concerns.

Oracle consultation `run_e2349902-2f03-466a-9214-24002a51ba22`, turn 3, endorsed
this replacement architecture and required explicit canonical JSON snapshot
semantics. That correction and focused regression requirements are incorporated,
along with small ownership, documentation and source-of-truth clarifications.
Turn 4 rechecked the changes and confirmed that the finding is closed, no
blockers remain, and this design is ready for implementation. The consultation
used the saved Oracle workflow's `claude-fable-5` profile through `keel-local`
and remains open for follow-up. Earlier consultations reviewed superseded
proposals and do not substitute for this review.
