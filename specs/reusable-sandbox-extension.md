# Reusable Pi sandbox extension and Linux smolvm consolidation

Status: proposed design and implementation plan, 2026-10-09. This document does
not describe shipped behavior or authorize implementation. Pi 1.1.0 is now merged
on public main at `420a0746b80a8deb32de9774cd5b173c5b4cd684`. A separate agent is
implementing Bubblewrap local networking and configurable process lifetime on that
base. Wait for its committed, reviewed checkpoint before extracting shared code;
do not use this older planning worktree as the implementation base.
Existing `docs/` remain authoritative for the current managed product. During
implementation, update the relevant subject documents in the same milestone as
each behavior change, plus `specs/pi-integration.md` when upstream seams change.

The concrete source inventory, proposed API boundary and evaluator change order
are in [the implementation map](sandbox-extension-implementation-map.md).

## 1. Objectives and boundaries

1. Keep the public Pi Sandbox repository self-contained and publishable. Users
   must not need another source repository or private Git access to build/use it.
2. House a standard Pi sandbox extension and all required runtime source there.
   Managed Pi Sandbox embeds its factory; ordinary Pi loads its packaged entry.
3. Add Linux smolvm execution to that extension using the existing prototypes.
   Preserve current Bubblewrap/direct tools, administrative restrictions,
   permissions, auditing, Git, MCP and Code Mode behavior.
4. Let the evaluator consume the same extension package and controller library.
   Ordinary Pi runs on the host; the evaluator owns VM families and records.
5. Remove persistent custom Python/C lifecycle supervisors from the new smolvm
   paths. The owning application performs normal cancellation and shutdown.
   Abrupt owner death may leave VMs running and require explicit operator cleanup.

Excluded: OpenCode, generic multi-agent protocols, Windows, macOS VM work,
Seatbelt integration, evaluation UI redesign, converting Git/broker tools into
standalone extensions, live provider calls, automatic host provisioning and
publication. Preserve existing macOS direct support; do not regress it while
changing shared modules. Seatbelt is the lowest-priority future follow-up.

## 2. Current state and selective source reuse

The current managed extension already implements Pi's standard ExtensionFactory.
It composes builtin replacement tools, permissions, managed tools, lifecycle and
audit handling. MCP and Code Mode are on the planning baseline, with managed
factory options supplied by Pi patches. Git uses a managed definition adapted
into a normal Pi tool; it need not change format for this work.

The ordinary-Pi prototype registers seven replacement tools and attaches to an
external OCI family. The evaluator already prepares candidate workspaces, forks
independent judges, exports evidence and retains candidates for cold inspection.
Its extension vendors a whole private runtime, including a persistent Python
subreaper. Older managed smolvm work supports a host-mounted project with a packed
tools image. Neither prototype should be merged wholesale into current Pi Sandbox.

Reuse current managed Bubblewrap/direct code as the baseline, preserving newer
file masking, path expansion, retention and MCP behavior. Reuse tool routing,
smolvm command logic, OCI family state and relevant offline/native tests from the
prototypes selectively. Move shared environment/limit validators out of their
incidental Seatbelt source location without importing that backend. Do not import
old supervisor protocols, OpenCode adapters, old configuration shapes, temporary
experiments or stale managed application code.

Source imports require a recorded revision/file inventory, license/notice review
and an inspection for private data. Do not publish private repository history,
machine-specific handoffs, provider endpoints, credentials or evaluation results.
After cutover the public repository is canonical for the imported code; there is
no continuing vendor-sync obligation or private runtime dependency.

## 3. Repository and package structure

Use one repository with an internal package, not another repository per layer:

```text
packages/sandbox-extension/
  src/index.ts                ordinary Pi extension entry
  src/factory.ts              trusted composition entry
  src/config.ts               strict extension/attachment configuration
  src/tools/                  seven tool definitions and guest operations
  src/policy/                 authorization engine and optional Pi UI integration
  src/runtime/contracts.ts    bounded execution and explicit capabilities
  src/runtime/bubblewrap/     current implementation and worker assets
  src/runtime/direct/         explicit direct executor
  src/runtime/smolvm/         host-workspace and OCI-family implementations
src/extension/                managed product composition
src/mcp/                      managed MCP admission adapter
src/codemode/                 managed Code Mode composition
src/runtime/                  managed config/bootstrap/audit lifecycle
```

The exact directory spelling may change after the upgrade; the boundaries must
not. Keep managed-only patched Pi imports out of the ordinary extension's import
graph. The package exports a normal Pi entry and narrow `/factory`, `/runtime`,
`/controller`, `/config`, `/policy` and `/identity` subpaths, as defined in the
implementation map. Importing the controller must not register a Pi
extension, start a VM, or load the managed product. Factory construction has no
side effects until explicit initialization.

The managed executable bundles package source and runtime assets at build time.
The ordinary extension artifact includes JS, required workers/guest helpers,
licenses and provenance. It has no dependency on an adjacent source checkout.
Use the selected Pi release as a peer integration; do not bundle a second Pi SDK
into the ordinary extension. Test that both consumers resolve the intended APIs.
The first package declares an exact peer version matching the accepted upstream
upgrade, and the evaluator pins its Pi executable/package to that same version.
Managed source pins, extension peer/dev pins and evaluator Pi pins must agree in
release checks. Supporting a broader range later requires explicit qualification;
an untested semver range is not a compatibility policy.
Standard public dependencies and the explicit smolvm executable/image are still
prerequisites; self-contained source does not mean bundling arbitrary VM images.

Initially distribute a reproducible npm-format tarball built by Pi Sandbox's
release process, with version, source commit and SHA-256. The evaluator pins the
immutable artifact and integrity; local development may consume a local tarball,
but a release lockfile must not depend on a sibling path or private Git URL.
Registry publication is optional later, not a new prerequisite. Inspect both the
managed release and standalone package from the final release commit.

## 4. Execution and lifecycle ownership

| Caller                     | Execution environment                         | Owner                   | Pi shutdown         |
| -------------------------- | --------------------------------------------- | ----------------------- | ------------------- |
| Managed Pi Sandbox         | Bubblewrap/direct or selected smolvm workload | Managed application     | Close owned backend |
| Ordinary standalone Pi     | Explicit sandbox extension configuration      | Extension in Pi process | Close owned backend |
| Evaluation candidate/judge | Assigned OCI family machine                   | Evaluator daemon        | Detach client only  |

The extension presents the same tool implementation over a bounded executor:
execute with stdin/output limits, deadline and cancellation; probe; guest CWD/home;
and close with explicit ownership. Ownership is selected through a discriminated
trusted configuration/factory input, never guessed from an environment variable.
An attached client's close cannot destroy a machine or remove its state.

The controller library runs inside the owner process. Evaluator attachments use a
private local socket and machine-scoped host capability, as today. That server is
part of the evaluator, not a new daemon or a general remote agent API. Only the
owner API can create, branch, stop, delete or retain machines. Attachments cannot
select host commands, alter mounts/network or obtain another judge's machine.
Tokens/configuration stay outside guest mounts, prompts, transcripts and exports.

No persistent custom watcher/subreaper is launched. Native smolvm/VMM processes,
short-lived CLI calls and legitimate execution workers are distinct from such a
watcher. Keep the existing Bubblewrap worker; this plan does not remove it.
Python or Node inside a guest may still be a workload/tool dependency.

Map ownership to actual Pi lifecycle events rather than treating every session
event as process exit. Conversation new/resume/switch keeps the same attached
machine while the adapter remains loaded. A genuine extension unload/reload must
release its owned resources exactly once before any replacement starts; a borrowed
adapter only detaches and can reattach to the same evaluator-owned machine. Test
the upstream event sequence and define the standard entry's reload path explicitly.
Never let a duplicate event close the replacement instance's backend.

## 5. Two explicit smolvm workload contracts

### Standalone and managed host-project workflow

The user confirmed the host project is mounted writable. Preserve the earlier
managed workflow: a trusted prepared packed tools image, a single host launch CWD
exported at the identical guest path, with writability selected by the existing
administrator CWD policy (the intended normal workflow is RW). Edits appear directly
in the host project; an explicitly RO policy must remain RO.
The guest image/root supplies toolchain dependencies and writable runtime storage.
Do not mount the entire host root, unrelated host directories, or private
Pi/provider/control stores, and do not inject provider credentials. Selected
project contents are intentionally visible, including any secrets already inside
that project; this is not an automatic secret filter. Reject mappings that include
private control/configuration state.

This workflow does not promise snapshots of host files, judge branching, or cold
reopening of a host-project snapshot. VM shutdown does not undo project edits.
Root/image state is disposable by default; project contents persist on the host.
Guest paths outside the project refer to the guest, not a transparent view of the
host. Unsupported host filesystem projection requests fail validation rather than
silently claiming Bubblewrap-equivalent semantics.

Preserve the packed prototype's offline-only network contract initially:
`network.mode = "none"` is required; reject `host` or filtered-network settings for
this workload rather than adding an unqualified packed-runtime capability. This
denies external guest connectivity, not every Linux guest socket operation (local
guest IPC may work). It must not be described as Bubblewrap's socket-creation
filter. Host Pi model/MCP traffic is separate and remains possible.

### Evaluator OCI family workflow

Preserve the qualified Linux x86-64/KVM OCI workflow: a prepared OCI archive,
writable guest root and `/workspace`, no writable host workspace mount, and
explicit read-only external inputs at separate guest paths. Trusted host setup
may clone/prepare a repository; fixed import transfers it into the guest; optional
guest setup prepares the scenario. Images are prepared separately from trusted
recipes. Neither a Dockerfile nor a Smolfile becomes runtime policy.

OCI retains its existing explicit `none` (default) or `host` network choice.
`none` disables the external guest network path; `host` enables the pinned
smolvm network path to host-reachable services. This does not literally join the
host kernel network namespace and provides no filtered-egress guarantee. Verify
external denial/allow controls natively for each workload, including every branch.

Freeze the completed candidate once and create independent writable siblings for
the evidence collector and each judge. Judge mutations never affect the retained
candidate or another judge. Branching includes guest processes; completion of a
Pi turn is not guest quiescence. External RO inputs remain external and mutable
by their host owner; they are not snapshotted. Preserve the existing bounded
workspace artifact plus candidate disks; delete disposable judges/collectors.
Cold inspection reboots retained disks on the same host, not guest RAM/processes.

Candidate retention is intentional disk persistence, distinct from a live orphan.
The evaluator remains the owner of retained-state records and uses its existing
`always`/`failed`/`never` policy and explicit prune operation. Default `always` has
no automatic age/quota eviction; the operator is responsible for capacity and
pruning. Prune refuses active/dependent/cleanup-uncertain state and preserves
workspace artifacts as the current contract specifies. Incompatible receipts
remain forensic/manual-cleanup state rather than eligible cold-reopen records.
Report capacity failures as infrastructure errors and avoid deleting evidence to
make space. No new quota service or automatic retention scheduler is added.

Keep these workload kinds explicit. Share tool adapters and CLI/ownership
primitives without pretending a writable host share supports isolated snapshots.
Start with qualified Linux x86-64 smolvm. Existing Bubblewrap Linux architectures
remain supported; additional smolvm architectures need their own qualification.

### Trusted inputs and managed configuration

The managed distribution selects the absolute smolvm distribution location at
build time, pins its version and hashes required executable/adjacent payloads, and
verifies them before use. No PATH search, ambient runtime override, on-demand
download or alternate-runtime fallback is allowed. System-provisioned smolvm is
sufficient for the first release; bundling its distribution is not required.
Changing that provider requires another distribution build, including review
builds that permit an alternate administrative configuration file.

Administrator configuration selects the prepared packed image with an absolute
canonical path and required SHA-256, verified before startup, plus bounded CPU,
memory/storage and execution limits. Image and runtime stores must be outside
tool-writable project/control mounts. The image is trusted provisioning input;
the model cannot select it or supply startup scripts. Ordinary Pi/evaluator
operators select these inputs explicitly in their own strict configuration, with
the same image/runtime identity recorded for reproducibility.

Introduce the next managed schema version after the upgrade checkpoint. Add
`execution.backend = "smolvm"` and one defined backend configuration block for the
image/digest/resources; keep host CWD selection implicit in launch CWD and its
existing writability policy. Require offline networking and reject filesystem
masks/host projection unsupported by this workload. Validate backend-specific
fields and incompatible combinations after broker merging. Preserve administrative
model selection, broker rules, parent audit and `allow_config_override`; smolvm
must not inherit the prototype's blanket ban on identity/audit/extensions. Update
templates, broker validation, release/installer checks and documentation together.
No old-version parser or alternate field names remain active after the change.

The extension config uses one strict discriminated owned/attached format with a
new version when needed. The evaluator updates producer/consumer pins and local
config together; persistent database format changes require a migration. Neither
an attachment nor a model request can select a host executable or VM image.

## 6. In-process smolvm lifecycle and failure semantics

Replace supervisor command transport with bounded child-process execution in the
owner: fixed argv, sanitized environment, timeout/abort propagation, bounded binary
stdin/stdout/stderr and backpressure. Preserve family queue/admission limits.
Create a private state namespace and record machine identities before admitting
tools. Import/start/probe failures must attempt bounded cleanup and report the
original failure together with any cleanup uncertainty.

Lifecycle states are starting, ready, closing, stopped, or cleanup-uncertain.
Closing revokes new work and attachment authority immediately. Concurrent calls
share one close result. Stop leaves before sources; never delete disks or publish
a cold-ready receipt before all relevant VMMs are verified stopped. A successful
CLI exit alone is not proof of guest death. Identify the pinned runtime's actual
machine process and validate its identity, including protection against PID reuse.
Prefer a validated smolvm stop/force-stop operation; any owner-side escalation
must target the verified owned machine, never a guessed PID or broad process scan.

Retain current conservative OCI behavior initially: command timeout/cancellation,
output-limit failure or lost execution control retires the family. Standalone
smolvm likewise closes the owned VM on uncertain command cancellation. Do not
claim a detached guest process stopped just because its foreground CLI exited.
A later narrower per-command cancellation contract is out of scope.

Normal Pi shutdown, evaluator stop and handled termination signals await bounded
cleanup. SIGKILL, owner crash or machine reboot do not carry an automatic cleanup
guarantee. No dual monitor or guardian-crash protocol replaces the removed helper.
On failed/uncertain stop, preserve disks and diagnostic identity and return an
explicit failure; do not mark retained state cold-ready. Startup recovery marks
interrupted records and surfaces leftovers rather than silently deleting them.

Provide exact operator listing/stopping instructions with the private state/XDG
environment and recorded machine names; default smolvm state may not show them.
Prefer a small diagnostic command that prints those scoped commands if needed.
Automatic sweeping of unrelated/default-state VMs and a general recovery daemon
are excluded. The qualification gate is bounded normal cleanup plus truthful
crash recovery, not guaranteed cleanup after owner death.

Retained receipt format is versioned. If helper removal changes its identity or
validity contract, write a new strict version and reject incompatible old receipts
without changing/removing their disks. Keep old records/evidence inspectable and
document manual cleanup; no dual-shape compatibility parser is planned. Evaluator
schema changes, if necessary, use an explicit store migration.

## 7. Policy, tools, MCP, Code Mode and Git

The sandbox extension controls its seven tools and user-shell route; it does not
confine arbitrary extension JavaScript, host processes launched by other
extensions, host MCP servers or remote services.

Extract reusable policy logic and Pi approval/session integration inside the same
package. Managed composition supplies mandatory authorization and audit hooks.
Ordinary Pi/evaluation may use explicit noninteractive role policy or no approval
UI. An explicit allow policy is different from failure to initialize a required
managed policy; failures never silently become allow.

Each managed tool prepares normalized execution arguments, authorizes an immutable
snapshot, then executes that same request. Filesystem enforcement remains in the
backend; argument equality alone does not solve filesystem alias/race problems.
MCP dispatch additionally binds original server/tool identity and current catalog
revision, invalidating stale grants/approvals. Preserve these wrappers for nested
Code Mode calls, not only top-level tool-call hooks. Generic extension event order
must not become the security boundary. Preserve existing fixed-allow user `!`
behavior in the managed product and route it through the selected backend.
Keep model-tool audit emission in the parent with the existing allowlisted fields,
normalized execution targets and bounded Bash metadata. Do not start logging file
contents, tool output, MCP secrets or attachment data. smolvm uses the same audit
decision/execution lifecycle as other backends; it does not disable the broker or
auditor merely because its tool worker is a VM.

Tool activation and tool authority are separate. Compute an effective role/admin
ceiling first; Pi selection may narrow it, never broaden it. Guard actual nested
execution even if Code Mode hides ordinary tools from the top-level model. An
empty tool ceiling means no callable file/shell tools. An explicit MCP server/tool
selection is separate; do not accidentally inherit ambient MCP by CLI omission.

For evaluations, add strict per-role MCP and Code Mode configuration with tools,
models, reasoning and timeouts. Load only selected stock Pi factories/extensions;
disable original host builtin execution and ambient extension/MCP discovery.
Stock Pi adapters must work without managed Pi patches. Host stdio or HTTP MCP
remains explicit authority outside the VM. A workspace-aware MCP needs a separate
guest bridge and is deferred. Model credentials remain in Pi's host store; host
MCP secrets must not be copied into guest environment or evidence.

An explicitly loaded stock MCP factory still reads ambient agent/project MCP
configuration by default. Compose it with an explicit stock `loadConfig` adapter
that supplies only the role's declared connections, or an equivalently isolated
generated configuration that has no fallback discovery. Merely passing
`--no-extensions -e builtin:mcp` is insufficient. Verify missing/empty role MCP
configuration results in zero admitted servers even when ambient files exist.

Code Mode stays in host QuickJS with mediated tool calls; do not expose host
Node/filesystem APIs. Do not import managed-only execution-limit options into a
stock factory that lacks them. Record the supported limits for each consumer and
apply bounded Pi-role lifecycle to evaluations. Code Mode-generated host artifacts
must be kept separate from guest workspace artifacts and redacted appropriately.
Stock Code Mode defaults to auxiliary model/classifier/image authority. The
evaluator explicitly composes it with `models:false`, so role model selection does
not silently grant additional model calls. Do not load the default builtin blindly.
Additional Code Mode model authority, if wanted later, needs an explicit scenario
contract; it is not part of this consolidation.

Git remains a managed host capability in its current format. The user accepts the
concurrent-writer race as a documented residual risk for the current clone-only
tool. Keep the repository host/scheme allowlist, fixed Git arguments, derived
destination and rejection of any destination already present at validation,
including symlinks. Preserve ordinary tool scheduling and credential isolation;
do not claim that scheduling stops background processes from earlier calls.

A surviving sandbox process could race the destination check and Git startup by
creating a symlink that redirects the host clone into another empty directory
writable by the host user, outside the sandbox's permitted project. Native probes
reported that Git follows such a symlink and rejects nonempty destinations. The
accepted scenario is a redirected clone into an empty directory; an arbitrary
existing-file overwrite or a timed exploit against the current wrapper has not
been demonstrated. The race window has not been measured. This records observed
behavior and an accepted policy gap, not a general proof about all Git writes.

Do not require background-process termination, protected staging, a publication
helper, a persistent guardian or a generic host-mutation lease specifically for
`git_clone`. This decision resolves the earlier host-clone discussion gate for
managed smolvm. It does not change current Bubblewrap cleanup by itself; another
agent will handle the separately discussed process-lifetime/networking changes.
Future fetch/pull tools need their own assessment and are outside this decision.
Evaluator host setup clones before importing the workspace into the VM; that flow
does not expose the clone destination to a concurrently writable guest mount.

## 8. Pi 1.1.0 upgrade handoff

The upstream pin and upgrade patches are merged at `420a074`, selecting Pi 1.1.0
source `abe508e1b89912adde45528136c3221eb69acdd7`. The planning worktree still starts
on Pi 1.0.2. Wait for the separate Bubblewrap feature checkpoint before moving
product source. Preserve this document onto that checkpoint without resetting
another agent's worktree or importing old managed
application branches wholesale.

Known changes must be qualified against the actual delivered code:

- Additive `--tools +codemode,-bash`, wildcard/MCP selectors and activation order.
  Selection must remain within the configured ceiling for ordinary and nested
  calls; existing literal-name filtering is insufficient. Upstream rejects mixed
  plain/modifier lists and wildcard modifiers; preserve those distinctions.
- Explicit MCP disable/selection under deterministic ordinary-Pi launches; no
  automatic admission merely because stock Pi keeps MCP alongside selected tools.
  An ordinary allowlist without an `mcp__` selector is not an MCP allowlist. The
  managed compositor must deliberately honor `--no-mcp` or reject it, since its
  manually composed factory does not automatically inherit builtin discovery flags.
- Code Mode tool instructions/output and image artifacts, plus the distinction
  between stock APIs and our patched managed limits/dispatch options.
- MCP connection/menu responsiveness without reopening settings or connection
  discovery that the managed product intentionally forbids.
- Seven replacement definitions, renderer host I/O, initialization timing and
  user-shell operations after upstream factory/signature changes.
- Evaluator RPC handling for additive event fields, especially aborted settled
  turns: cancellation must not become a successful candidate or valid judgment.

The handoff must include the exact source/package pins, patch inventory, managed
contract tests, required integration/release results and Keel findings/fixes.
Version-specific adapter edits may change; ownership, repository boundaries and
the no-supervisor lifecycle direction do not depend on those details.

The sandbox consolidation is intended to use the standard extension/factory seams
and needs no new smolvm-specific upstream Pi patch. Existing generic managed
patches remain owned by the upgrade contract. If a missing seam is demonstrated,
review it explicitly before adding a minimal generic patch; never scatter backend
policy through upstream Pi or silently require that patch for ordinary Pi.

Official reference: [Pi 1.1.0 release](https://github.com/earendil-works/pi/releases/tag/v1.1.0).
Read-only source review also checked the pinned
[CLI contract](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/cli.md),
[tool selector](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/settings-manager.ts),
[resource loader](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/core/resource-loader.ts),
[MCP factory](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/extensions/mcp/index.ts),
[Code Mode factory](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/extensions/codemode/index.ts)
and [Code Mode tool](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/src/extensions/codemode/tool.ts).
Stock explicit `-e builtin:mcp` / `-e builtin:codemode` composition under
`--no-extensions` is a candidate launch mechanism, pending acceptance tests.
Stock 1.1.0 still lacks our managed MCP adaptation options and Code Mode
`executionLimits`; do not treat a successful source upgrade as removal of those
patch requirements.

## 9. Execution order and milestone acceptance

| Milestone                         | Work                                                                                                                    | Acceptance                                                                                                                                                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0: preparation                   | Isolated sibling worktrees, this plan, source inventory and upgrade impact review                                       | Pi upgrade merged; extraction map reviewed; committed and reviewed Bubblewrap feature checkpoint pending                                                                                                                                                |
| P1: package boundaries            | Start on reviewed Bubblewrap checkpoint; separate tools/runtime/policy and managed composition; public import audit     | Existing managed behavior passes; ordinary package loads without patched-only imports; fresh public checkout builds without private repos                                                                                                               |
| P2: Linux runtime                 | Import focused smolvm implementations/tests; replace supervisors with in-process ownership; strict state/error handling | Native cleanup/cancel/failure controls pass; uncertain state retained; no custom watcher launched; manual orphan cleanup demonstrated                                                                                                                   |
| P3: managed and standalone smolvm | Owned host-project VM, packaged ordinary entry, admin backend config, existing host Git with accepted residual risk     | Host project RW/RO, seven tools/`!`, policy/MCP/Code Mode and Bubblewrap/direct regressions pass; clone allowlist, fixed arguments and existing-destination rejection pass; concurrent-writer limitation is documented without claiming it is prevented |
| P4: evaluator consumption         | Pin same package; replace private dependency; preserve OCI family/retention flow; explicit per-role MCP/Code Mode       | Offline end-to-end candidate plus multiple independent judges, evidence/cold inspection and MCP/Code Mode cases pass                                                                                                                                    |
| P5: release readiness             | Final docs, demos, package/version/provenance and installation checks                                                   | Managed archive and extension tarball inspected at final source SHA; no private dependencies/data; reproducible Linux demo and recorded limitations                                                                                                     |

P1 can separate tool and policy modules in parallel under agreed interfaces.
P2 can separate host-project and OCI tests while sharing one lifecycle owner.
Evaluator configuration work may proceed after the package API freezes, but final
acceptance waits for P2/P3. Keep one integration owner for shared contracts and
lockfiles. Product source changes await the Bubblewrap feature checkpoint and
implementation go-ahead.
The host Git-clone decision is resolved by the accepted residual risk in section 7.
Do not silently omit Git or reinstate staging/process-cleanup prerequisites for it.
Passing clone validation tests must not be described as proving the race absent.

Use subagent reviews plus iterative Keel `claude-default` review at package/policy,
lifecycle, consumer and release milestones. Incorporate correctness findings;
do not expand into deferred platforms, new UI or generalized orchestration.

## 10. Verification matrix

- **Package:** clean public clone, exact public dependencies, inspect packed files,
  worker/helper assets, licenses and provenance; Node/Bun imports and ordinary Pi
  loading; no checkout-relative paths, private Git URLs or default side effects.
- **Managed regression:** unit/type/lint/format; real Bubblewrap integration;
  permissions/approval argument identity; models/broker/config override gates;
  hidden paths, session retention, direct mode and Linux release/install checks.
  Carry forward existing platform-neutral compile and Darwin-target packaging
  checks. New native macOS work is deferred by the user; do not claim a new native
  Darwin qualification or release Darwin artifacts without the existing direct-mode
  smoke gate. A Linux-only release is the target of this workstream.
- **Tool composition:** all seven tools and user shell; no host resolver/rg leak;
  startup failure; tool ceiling, modifiers/wildcards and Code Mode nested denial;
  approved MCP, denied/unselected server, ambient MCP rejection, catalog change,
  auxiliary Code Mode model calls disabled and cancellation; new/resumed/switched
  conversations, extension reload and once-only owned/borrowed cleanup.
- **Standalone VM:** actual prepared tools image; host RW/RO project; outside
  host path denial; offline network controls and unsupported-mode rejection;
  administrative broker resolution, parent audit, MCP/Code Mode and agreed Git
  behavior; CLI stdout/binary streaming, stdin,
  output pressure/limits, cancellation, deadlines, clean exit and failed stop.
- **OCI VM:** Rocky Linux x86-64; whole-root writes, compiler/test workflow, RO
  inputs, independent siblings, repeated freeze/branch, leaf-before-source stop,
  none/host network controls, stopped worker/detached writer cases, successful cold
  reopen and invalid receipt.
- **Crash semantics:** kill the owner, explicitly observe possible survivors,
  demonstrate scoped smolvm listing/cleanup and preserve unconfirmed state. Do not
  retain obsolete tests requiring a subreaper acknowledgement after owner death.
- **Evaluator:** `bun run check`, offline scripted-provider end-to-end with two
  judges, no credential/attachment leakage, workspace archive integrity, invalid
  judgment handling, retained candidate inspection and normal daemon shutdown.

No new live-model calls, service installation or global tool provisioning is
needed for these milestones. Necessary native fixture processes/state are bounded
and cleaned; inability to clean is recorded, not hidden by deleting metadata.

## 11. Open implementation gates, not extra scope

- Committed, reviewed Bubblewrap feature checkpoint, its schema/protocol versions
  and regression report; Pi 1.1.0 itself is already merged.
- Validated stop/force-stop and stable VMM identity path for pinned Linux smolvm
  after supervisor removal; a stop timeout cannot be reported as success.
- Public package name/artifact URL and version chosen when packaging lands; the
  design requires one immutable artifact, not a new registry service.
- Whether retained-state identity changes require a strict receipt bump and a
  corresponding evaluator migration. Old data must not be silently destroyed.
- Qualification of stock Pi MCP/Code Mode configuration and generated artifacts
  with the VM attachment, separate from managed patched adapters.

## Correspondence

Initial draft prepared for subagent and Keel review. No product code changed.

### 2026-10-09 - Source research and user clarification

Two read-only subagents reviewed the architecture/source inventory and official
Pi 1.1.0 APIs. Their findings are incorporated above: retain separate host-project
and guest-local OCI workloads, preserve exact authorization/dispatch coupling,
avoid importing obsolete Bubblewrap/Seatbelt code, explicitly gate Git host writes,
and account for upstream MCP/tool selection and host Code Mode artifacts. They
ran no tests or VMs and made no source changes.

The user reconfirmed writable host-project mounting for standalone Pi Sandbox.
The evaluator continues to store its workspace inside the VM, with retained disks
and a separate exported workspace artifact; no writable host workspace mount is
introduced. These are separate use cases sharing tools and runtime primitives.

### 2026-10-10T02:12:24.638Z - Reviewer: claude-default

Read-only design review of the consolidation plan against the current `docs/`
and `specs/pi-integration.md` contracts. No tests, VMs, installs, or fetches were
run, and no file other than this correspondence section was changed. The core
direction is sound and coherent with the end-state invariants: one self-contained
public package exporting an ordinary Pi entry plus a trusted managed factory;
preserved Bubblewrap/direct, permissions, MCP and Code Mode behavior; two explicit
smolvm workloads (writable host project versus guest-local OCI root plus
`/workspace` with independent judges and retained disks); removal of the
persistent Python/C supervisors; and honest crash-leftover semantics with scoped
operator cleanup. The repository/package boundaries, the ownership table, and the
no-supervisor failure contract (bounded child-process execution, verified VMM
identity before escalation, cleanup-uncertain state, versioned receipts without a
dual-shape parser) are internally consistent. The deferred scope and the separate
Pi upgrade handoff are correctly bounded.

Status: changes-requested. The following are design-completeness gaps, not
objections to the chosen direction.

1. (high) smolvm network authority is undefined. The Bubblewrap invariant fixes a
   `none`/`host` contract with default-deny socket creation and no filtered mode;
   this plan adds a full-VM backend but specifies networking only as a test item
   ("guest networking choice") with no default, no allowed modes, and no mapping
   to the existing network contract. Define the smolvm network authority (default
   and permitted modes) for both the host-project and OCI workloads.
2. (medium) The smolvm executable/image provider trust and selection contract is
   missing. Bubblewrap requires a build-selected absolute-system or
   digest-verified bundled provider that runtime configuration cannot change; the
   plan names the smolvm binary/image a prerequisite but never states its trust,
   verification, or whether runtime configuration may select it. Define a parallel
   provider contract for managed standalone smolvm.
3. (medium) Configuration is strict and versioned and rejects unknown fields, yet
   the plan never describes how `execution.backend` and smolvm-specific settings
   (image/root, host-project RW/RO, network, resource bounds) enter the schema or
   whether a schema-version bump is required. Specify the schema evolution and
   strict validation for the new backend.
4. (medium) Retained evaluator candidate disks are intentional, but no lifecycle
   owner, quota, or cleanup policy is defined, so they accumulate without bound
   across runs (reinforced by section 6 keeping incompatible-receipt disks for
   manual cleanup). Distinguish intentional retention from crash leftovers and
   state who deletes retained disks and when, even if operator-owned like audit
   logs.
5. (medium) The plan commits to preserving macOS direct support while refactoring
   shared modules (including moving validators out of the Seatbelt source
   location), but the verification matrix has no explicit macOS build/direct
   non-regression step; a shared-module move could regress it silently.
6. (medium) The ordinary extension consumes "the selected Pi release as a peer"
   but relies on a test rather than a declared peer-version contract. Managed-
   compiled Pi, evaluator-pinned Pi, and the extension's peer range can diverge;
   declare the peer Pi version pin/range so the consumers cannot silently skew.
7. (low) Affirm whether the smolvm consolidation requires any new upstream Pi
   patches or is fully contained to the extension/controller, so the minimal
   patch series and the upgrade handoff in section 8 remain accurate.
8. (low) State whether smolvm tool executions preserve the existing model-tool
   audit/event-collection semantics (target paths, bounded Bash, content/output
   exclusions), so the new backend does not open an audit gap.

Items 1–3 are the most material because they define security and configuration
boundaries for a new VM backend that the plan otherwise leaves to implicit
implementation. Addressing them (and recording items 4–8) would make the plan
ready; the section 11 gates already capture the stop/force-stop path, clone
publication safety, receipt-bump/migration, and artifact naming, so they need no
change here.

### 2026-10-09 - Coordinator response to first review

Addressed all eight findings with explicit workload network defaults/limits,
build-selected verified runtime and admin image selection, strict schema bumps,
operator-owned retention/pruning, existing Darwin compile/packaging preservation
without resuming native macOS work, an exact Pi peer/consumer pin, no planned new
upstream backend patch, and preserved parent audit semantics. No quota service,
new daemon, alternate configuration parser or extra platform was added.

Subagent draft review refinements were also incorporated: ordinary MCP must not
fall back to ambient configuration; Code Mode auxiliary model calls are disabled;
owned versus borrowed cleanup covers reload/session transitions; mounted project
contents are visible without a secret-filtering promise; and managed smolvm must
qualify broker/audit/MCP rather than inherit old prototype restrictions.

The user requested discussion of clone-related complexity. Standalone host Git
handling is explicitly undecided, and no staging/publication helper has been
selected. This does not change the no-persistent-guardian decision or the
evaluator's existing clone-before-guest-import setup flow.

### 2026-10-10T02:19:01.014Z - Reviewer: claude-default

Re-review for consistency and bounded scope after the coordinator update. No
tests, VMs, installs, or fetches were run, and no file other than this
correspondence section was changed. All eight prior findings are resolved in the
main design, and the resolutions are consistent with the current `docs/` and
`specs/pi-integration.md` contracts:

- Network (finding 1): standalone host-project now requires `network.mode = "none"`
  and rejects `host`/filtered settings, while OCI retains explicit `none`/`host`;
  both honestly disambiguate smolvm networking from Bubblewrap's socket filter and
  are covered in the verification matrix.
- Provider/image trust (findings 2) and config schema (finding 3): §5.3 adds a
  build-selected, pinned, hash-verified runtime with no PATH/download/fallback, an
  admin-selected SHA-256 image the model cannot choose, and a strict new backend
  schema version with no residual old-shape parser.
- Retention (finding 4): §5 makes retained disks operator-owned under the existing
  `always`/`failed`/`never` policy plus explicit prune, with no new quota service
  or scheduler, and distinguishes intentional retention from live orphans.
- macOS (finding 5), peer pin (finding 6), no-new-patch (finding 7), and parent
  audit (finding 8) are each addressed with bounded, end-state wording.

The incorporated subagent refinements are also sound and in scope: the explicit
stock `loadConfig` adapter closes the ambient-MCP fallback, Code Mode `models:false`
removes silent auxiliary model authority, owned-versus-borrowed reload/session
cleanup maps ownership to real Pi lifecycle events, and the mounted-project wording
is honest about visible project secrets. Making the standalone host Git-clone
contract an explicit undecided gate (rather than a presumed helper) is the correct
response to the user's request and does not expand scope.

Status: changes-requested for one low-severity consistency item only; the design
is otherwise ready.

1. (low) The P3 milestone (§9) still lists "Git capability handling" as work with
   acceptance "clone controls pass," but §7 and §11 now make the standalone
   host-clone contract an undecided user-discussion gate that managed smolvm
   release waits on. A reader could read P3 as requiring a finished clone contract
   that the design says is not yet decided. Reconcile the milestone wording so P3
   delivers the Git safety controls and Bubblewrap-unchanged verification, and the
   standalone clone capability (and any managed smolvm release depending on it)
   is explicitly contingent on the §11 Git gate.

No other inconsistencies or scope regressions were found. The deferred scope
(macOS/Seatbelt VM, OpenCode, UI redesign) and the separate Pi upgrade handoff
remain correctly bounded.

### 2026-10-10T02:21:50.512Z - Reviewer: claude-default

Confirmation re-review after the coordinator update. No tests, VMs, installs, or
fetches were run, and no file other than this correspondence section was changed.

The sole remaining low-severity item is resolved. The P3 milestone work now reads
"explicit host-Git decision gate" instead of a Git capability deliverable, and its
acceptance explicitly keeps existing Bubblewrap Git unchanged while making smolvm
clone implementation and release contingent on resolving section 11's Git gate and
passing the agreed controls. The new paragraph beneath the milestone table states
that the undecided Git contract does not block package extraction or runtime work,
does block declaring managed smolvm complete or releasing it with a silently
missing or unsafe clone capability, and requires the discussion to precede clone
implementation assignment or any claim of passing its acceptance tests. This is
consistent with §7 (Git handling is an unresolved product discussion; managed
smolvm release waits for an agreed host-clone contract) and §11 (the Git-clone
contract gate), and the §10 "agreed Git behavior" wording aligns.

The Prettier reformatting of the §4 ownership table and the §9 milestone table
preserves content; no design meaning changed. All eight earlier findings remain
addressed, the bounded scope and deferred items are intact, and no
environment-specific data was introduced.

Status: clean. No further findings. The plan is ready as a reviewed design and
implementation plan, subject to its own stated gates (the tested Pi upgrade SHA,
the stop/force-stop and VMM-identity path, and the host Git-clone contract), which
are correctly held open rather than presumed resolved.

### 2026-10-09 - User accepts the host clone race as a residual risk

After the review above, the user declined additional clone-specific staging or
background-process termination. Proceed with the current restricted clone tool
and document the possibility of a background process redirecting the destination
to an empty host directory between validation and cloning. Sections 7, 9 and 11
now reflect that accepted tradeoff and remove the host-clone decision gate.
The user plans to delegate local-only Bubblewrap networking and configurable
background-process lifetime separately; neither is implemented by this amendment.

This is a user-directed planning amendment after the clean Keel review, not an
additional reviewed or tested implementation. Earlier correspondence is retained
as historical evidence and its open Git gate is superseded by this decision.
