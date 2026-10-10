# Sandbox extension extraction and evaluator attachment map

Status: preparation only, 2026-10-09. Read together with
[the consolidation design](reusable-sandbox-extension.md). This document records
source inspection and proposed implementation boundaries, not new runtime
qualification. No application implementation or native tests accompanied it.

## 1. Baselines and incoming work

Public Pi Sandbox main `420a0746b80a8deb32de9774cd5b173c5b4cd684` contains Pi 1.1.0,
pinned to upstream `abe508e1b89912adde45528136c3221eb69acdd7`. API inspection used
the official archive matching `pi-source.lock.json`, not whichever SDK happened
to be installed in a checkout. The package, managed build and evaluator must all
select that same Pi release unless a later explicitly qualified pin supersedes it.

A separate agent owns the following incoming Bubblewrap changes:

- `network.mode = "local"`, loopback TCP/UDP in a private network namespace;
  preserve default `none` and existing `host`, block host Unix sockets including
  the reported datagram socket-pair bypass.
- `execution.process_lifetime = "command" | "sandbox"`, default `command`;
  persistence across calls and conversation changes in `sandbox` mode.
- Pi 1.1.0 output completion in persistence mode: its post-exit idle timer resets
  on output; no added absolute drain deadline or configuration. Redirection is
  advice, not an execution requirement. Existing timeout/output limits remain.
- Cancellation/error cleanup, shutdown, configuration/broker integration,
  documentation, native controls and Keel review.

Do not edit or move its worker, protocol, seccomp, config, broker, diagnostics or
test files in parallel. Begin extraction from its final committed and reviewed
checkpoint, carrying these planning documents forward. Preserve its exact default
and cancellation semantics; do not independently reimplement them from this map.

The user accepted the host `git_clone` destination race. Preserve ordinary clone
validation and scheduling without adding clone-specific cleanup, staging or
helpers. See the design's section 7. That issue is no longer a decision gate.

## 2. Source ownership and import inventory

| Current source                                                                                                        | Intended location/responsibility                         | Required adjustment                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `src/extension/executor-operations.ts` and seven tool registrations in `src/extension/index.ts`                       | Package tool adapters                                    | Preserve normalization, rendering and guest execution; take a narrow executor and policy hook |
| `src/sandbox/*` at the incoming checkpoint                                                                            | Package Bubblewrap/direct runtime                        | Preserve new network/process behavior and ship worker assets for ordinary Pi                  |
| `src/host/{host-command-executor,contracts}.ts` and fixed executable mappings in `src/sandbox/bubblewrap-executor.ts` | Shared bounded process primitive where actually needed   | Direct executor may reuse the primitive; Git policy and credential selection stay managed     |
| Pure path/environment helpers, executor/error types                                                                   | Package leaf modules                                     | Remove dependency on the managed `domain/index.ts` barrel and compiled layout                 |
| `src/policy/policy-engine.ts` and `src/extension/approval.ts`                                                         | Package policy and optional approval integration         | Accept policy maps and callbacks, not the entire managed config                               |
| `src/runtime/main.ts`, config/account/broker/model/retention/bootstrap                                                | Managed application                                      | Remain owners of admin decisions and managed executor lifetime                                |
| `src/mcp/*`, `src/codemode/*`, managed tools/Git, audit client                                                        | Managed composition                                      | Retain patched admission, catalog revision, permission and audit behavior                     |
| Prototype extension `src/{extension,config,controller}.ts`                                                            | Selective reference for stock entry and borrowed adapter | Remove private vendor assumptions and seven-tools-only global gate                            |
| Prototype OCI `src/smolvm/oci/{family,transport,retention,types,disk-capacity}.ts`                                    | Package smolvm controller/runtime                        | Replace guardian dependency, preserve queue/branch/attachment/retention contracts             |
| Prototype `src/smolvm/oci/{guardian,guardian-source}.ts`                                                              | Not imported                                             | Replace command transport and shutdown responsibilities in owner process                      |
| Earlier managed packed smolvm prototype                                                                               | Selective host-project reference                         | Import focused runtime/image controls, not stale application or supervisor code               |

Prototype source checkpoints for later import auditing are extension `c188618`,
OCI runtime `f414fef`, and earlier managed smolvm `d0f1f72`. Record full source
revisions, actual imported files, licenses/notices and any subsequent edits in the
package's provenance before release. This table is a research inventory, not
permission to copy entire private repositories or their history into public Git.

Concrete coupling to resolve in the first extraction commit:

1. `domain/index.ts` reaches `buildLayout` and a managed virtual module through
   policy exports. Runtime imports need package-local leaf modules instead.
2. `ExtensionDependencies` mixes sandbox execution with admin config, MCP,
   auditing and host extensions. Do not make it the reusable factory interface.
3. Direct execution currently imports the host executor and Linux tool paths
   from Bubblewrap. Share the primitive/table without importing a managed host
   capability or making direct behavior depend on Bubblewrap initialization.
4. Managed worker startup uses `process.execPath --pi-sandbox-internal-worker`.
   Keep that managed entry if appropriate, but ordinary Pi must use the same
   worker implementation through a packaged JS asset and trusted runtime path.
   Pass `workerCommand: [<absolute trusted node/bun>, <packaged entry.js>]`; the
   entry calls `runSandboxWorker`. Resolve the runtime from the admitted host
   installation, verify its supported version and resolve the entry from the
   installed package. Neither path comes from the model, guest or workspace PATH.
   This is the existing execution worker, not a new lifecycle monitor.
5. Do not import managed-only MCP/Code Mode factory options into the ordinary
   package. Reuse stock tool schemas/renderers with replaced execution, never
   accidentally reinstall the stock host filesystem implementations.

## 3. Proposed package contract

Use one package in `packages/sandbox-extension` with narrow exports:

| Export           | Responsibility                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Default Pi entry | Standard `ExtensionFactory`; strict explicit owned/attached configuration                  |
| `/factory`       | `createSandboxExtension` over a supplied executor, tool ceiling and authorization callback |
| `/runtime`       | Executor/error contracts and backend constructors; no Pi initialization                    |
| `/controller`    | OCI family creation/reopening and machine attachment; no Pi import or side effects         |
| `/config`        | Pure strict configuration types/validation, distinct from managed admin config             |
| `/policy`        | Policy maps, immutable approval requests and optional stock Pi UI adapter                  |
| `/identity`      | Package version/source provenance; no private vendor-specific record                       |

Keep the existing bounded executor shape: `cwd`, `home`, `backend`, fixed guest
command paths, `probe`, `execute` and `close`. It need not become a generalized
remote-execution protocol. Add only request fields needed by existing guest
operations, using one canonical contract; do not retain two result shapes or
alias old managed configuration fields.

The factory's required managed call sequence is:

```text
normalize -> immutable execution request -> authorize -> execute same request
```

Managed composition supplies mandatory policy and wraps audit emission. The
ordinary consumer may explicitly choose noninteractive allowance within its tool
ceiling. Missing managed policy never implicitly means allow. Avoid a generic
event-only permission boundary: Pi tool-call handlers can modify arguments, and
nested Code Mode calls must use the same authorized execution closure.
Stock Pi 1.1.0 routes nested calls through `ctx.executeTool`, including ordinary
tool-call hooks. Compute authority from the immutable role/admin capability set,
not `getActiveTools()` (model visibility). Use one authorization path for direct
and nested execution; do not add a separate Code Mode permission engine.

Backend options are discriminated, not a universal capability claim. Carry the
incoming Bubblewrap `local`/process-lifetime options only where supported. Packed
host-project smolvm initially supports external networking disabled; OCI families
retain explicit `none`/`host`. Do not silently map Bubblewrap `local` onto OCI or
claim that guest loopback is denied in smolvm `none` mode. For managed smolvm, a
new backend config requires explicit `execution.process_lifetime = "sandbox"`.
The smolvm template sets that value; validation after broker merging rejects
`command`, including the inherited Bubblewrap default, because smolvm does not
implement per-command cleanup. Exact schema numbers follow
the incoming Bubblewrap checkpoint; do not reserve a competing version now.

## 4. Ownership, sessions and attachment

| Event                        | Managed application                   | Ordinary owned extension                                     | Evaluator borrowed extension                               |
| ---------------------------- | ------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------- |
| Startup                      | Application creates executor          | Create one backend in Pi process                             | Attach to specified family machine                         |
| New/resume/fork conversation | Keep process-owned executor           | Keep existing backend across replacement extension instances | Reattach to the same assigned machine if needed            |
| Extension reload             | Follow application lifecycle contract | Close old owner once before replacement starts               | Settle/cancel active work, detach old client, attach again |
| Pi quit                      | Application closes executor           | Close owned backend                                          | Disconnect only; evaluator still owns VM                   |
| Evaluator finishes candidate | Not applicable                        | Not applicable                                               | Evaluator freezes/branches/collects/judges/retains         |

Pi 1.1.0 recreates the session runtime for new/resume/fork and emits shutdown
reasons for them. The standard entry therefore needs one process-scoped owner
slot rather than an unconditional close in every `session_shutdown` handler.
This is one backend shared by the active conversation in that Pi process, not a
pool of per-conversation sandboxes. Switching conversations does not leave a
separate agent or sandbox running for each old conversation. Stock Pi itself
untracks completed shell operations without killing background descendants;
switching sessions aborts active work but does not sweep those completed jobs.
Keeping that backend adds no ownership-layer cleanup on conversation switch.
Background survival still follows the backend's process-lifetime contract:
`sandbox` mode permits it; the default `command` mode cleans up descendants after
each operation. Source inspection establishes the stock behavior; a new runtime
experiment was not performed during preparation.
Bind it to the admitted configuration and original workspace; do not broaden
mounts just because a resumed conversation has a different host CWD. Keep this
bookkeeping inside Pi, with generation-safe close/replacement, not in a daemon.
Handle the known event reasons explicitly: `new|resume|fork` keeps the owned slot,
`quit` closes it, and `reload` closes it once before replacement. Borrowed clients
keep or reattach their assigned machine across conversation switches, detach on
quit, and settle/cancel then detach before reload. Verify owner-slot persistence
and loader ordering with a stock-Pi fixture. Session transitions may themselves
abort active work; preserving ownership does not suppress the backend's existing
cancellation/retirement contract.

Borrowed close is not harmless during an active tool: the existing attachment
transport aborts disconnected requests, which can retire an OCI family. Settle or
explicitly cancel work before detaching and report resulting retirement honestly.
An extension reload must not silently abandon an in-flight operation.

Preserve the existing owner API, with names finalized during extraction:

```ts
createSmolvmOciFamily(options);
reopenSmolvmOciFamily({ statePath });
family.execute(machineId, request, options);
family.attachment(machineId);
family.branch(machineId);
family.removeMachine(machineId);
family.retainForColdReopen();
family.close({ retainState });
attachSmolvmOciMachine(attachment); // client.close() disconnects only
```

Attachments contain the private socket capability, machine identity, guest CWD
and home. They do not grant create/branch/delete or accept host runtime/image/mount
selection. The socket server already runs inside the evaluator; retain it. A
family marks itself closing before accepting new work, rejects frozen/deleted
machine attachments, and retires children before their source.

Keep host Git setup -> guest import -> candidate -> independent collector/judges
-> retained candidate plus workspace archive -> optional cold inspection. This
is already implemented by the evaluator; do not replace its scheduler or invent
a new sandbox service.

## 5. Removing the persistent supervisor

The Python guardian currently does more than observe parent death: it launches
smolvm CLI calls, relays binary streams, bounds requests and kills/reaps VMMs.
Replace these responsibilities explicitly, rather than simply deleting its spawn:

| Existing behavior                      | Owner-process replacement                                                |
| -------------------------------------- | ------------------------------------------------------------------------ |
| Fixed CLI argv and isolated HOME/XDG   | Bounded transient child process with the same scoped runtime environment |
| Stream framing and stdin/output bounds | Direct binary pipes, backpressure, cancellation and existing limits      |
| One active command                     | Existing family admission queue                                          |
| Guardian-owned VMM identity            | Record actual named-machine PID/generation and scoped runtime state      |
| Reap acknowledgement on close          | Named leaf-before-source stop plus verified stopped state                |
| Parent-death watcher                   | Removed; explicit operator cleanup after abrupt owner death              |

Pinned smolvm 1.23.1 source `9dada8e` already has named-machine stop, frozen-source
handling and process-identity checks. Its normal stop may leave a live VM when the
guest fails to acknowledge filesystem synchronization. Do not claim that calling
`machine stop` always succeeds, or treat killing the short-lived CLI as proof
that the VMM died. Validate normal close, stopped guest worker, startup error and
branch failure natively before accepting the replacement.

Use a validated upstream stop/force-stop path where available. Any escalation
needs a verified machine identity; no broad host process sweep. Failure or an
uncertain identity retains state and returns a cleanup failure, not a successful
close or cold-ready receipt. Do not build another guardian to hide this failure.
Operator diagnostics must include the exact scoped state environment and machine
names; default smolvm state might not contain these machines.

Receipt versions must distinguish the new teardown/identity contract when needed.
Old evidence/disks remain available; incompatible receipts are not silently
reinterpreted as reopenable. Existing native results prove the old supervisor
contract only and must not be relabeled as qualification of this replacement.

## 6. Evaluator change inventory

| Evaluator area                                            | Change                                                               | Preserve                                                                                             |
| --------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `package.json`, lockfile, extension location helper       | Pin immutable public-repo package artifact and exact Pi peer         | No sibling checkout or private Git dependency in a release                                           |
| `src/pi/launch.ts`, `src/engine/role.ts`                  | Deterministic role composition over stock Pi and borrowed attachment | Provider/model/thinking selection, private config removal, disabled ambient extensions/host builtins |
| `src/config/{schema,local,hashing}.ts`, model types       | Explicit role MCP/Code Mode options and new strict config version    | Existing scenario identity, tool ceiling, guest environment and judge selection                      |
| `src/engine/environment.ts`                               | Record package version/public source/artifact integrity              | Pi, runtime and image identity; no resolved secrets                                                  |
| `src/pi/rpc.ts`                                           | Handle Pi 1.1.0 `agent_settled.aborted` explicitly                   | Model/thinking verification and existing run outcome rules                                           |
| `src/engine/{attempt,reviewer}.ts`                        | Narrow package imports/identity integration                          | Preparation, two-or-more independent judges, evidence and candidate retention                        |
| `src/engine/recover.ts`, VM inspection and family records | Surface interrupted VMs under new ownership contract                 | No automatic deletion of uncertain state or assumption that killing Pi killed its VM                 |

Use machine-local named MCP connection definitions and profile/judge selections.
Resolved host credentials go only to the private role composition, never to
persisted profile/judge objects, configuration hashes, prompts or evidence. Hash
effective nonsecret capability declarations. Reviewer guest environment continues
to inherit the profile's existing guest environment; independent reviewer guest
environment is not required by this work.
Include resolved MCP credential values in existing packet, analytics and web
redaction inputs (`src/judging/packet.ts`, `src/analytics/clean.ts`,
`src/web/data.ts`). Add offline packet/view/export redaction controls without
redesigning the UI.

The current prototype globally rejects non-seven tools and uses `getActiveTools()`
as an execution permission. Replace that with a role capability ceiling that also
works when Code Mode hides tools from top-level presentation. `tools = []` permits
no sandbox filesystem/shell calls. Admitted MCP/Code Mode must not be blocked by
a blanket sandbox-only handler; unadmitted calls must still fail, including nested
calls. Keep the existing guest-only user-shell routing.

Compose `createMcpExtension` with a narrow forwarding adapter over stock Pi's
extension API; do not copy managed-only factory options:

- Provide explicit `loadConfig` and `updateConfig` for the admitted role servers;
  suppress implicit registered servers via forwarded `getMcpServers: () => []`.
  Do not load or write ambient agent/project MCP configuration.
- Wrap every `registerTool`, including refresh and withdrawal, with the immutable
  role ceiling and execution check. Preserve withdrawn tools' hidden state.
  Select by final Pi tool names, not decoded sanitized names or display labels.
- Treat `list_mcp_resources`, `list_mcp_resource_templates` and
  `read_mcp_resource` as explicit capabilities. When selected, these can reach
  resources on the role's admitted servers. Per-server resource policy is not
  part of this change.
- Return `autoEnableCodemode: false` in the MCP `LoadedMcpConfig` supplied by
  `loadConfig`; this is not a `createMcpExtension` factory option. Pass
  `models: false` to the Code Mode factory. Admit
  discovery only when selected; clamp forwarded activation so deferred tools
  cannot auto-enable an unselected `tool_search`. Keep visibility and authority
  distinct, including tools hidden from presentation by Code Mode.

Qualify refresh, withdrawal and direct/nested calls through this one composition.
Host/remote MCP remains outside the VM; workspace-aware guest MCP is deferred.
Do not introduce another broad plugin protocol to solve this seam.

Stock MCP can save large or binary results in host temporary files that guest
tools cannot read. Its public factory has no output-saver hook. The adapter must
use original structured result bytes where available: tool
`structuredContent.content[]`, resource `structuredContent.contents[]`, and the
structured `details.fullOutputPath` discriminator for truncated text. Never parse
a displayed path or follow a server-supplied host filename. Where materialization
is needed, transfer bounded bytes through the existing guest execution/stdin
connection into an owner-chosen guest artifact path and return that guest path.
This needs no writable host mount or general host-file reading tool. Qualify the
actual result representations before release; if a result cannot be represented,
report that the operation completed but its output is unavailable to the VM role,
without recommending a retry of a possibly mutating operation. Stock MCP may
already have created a host temporary file; do not claim this avoids all host
temporary output.

A dependency pin alone needs no database migration. If persistent records or
cold-reopen eligibility change, add a narrow migration preserving old evidence and
disks. The existing family status model may suffice; no new table is assumed.
The attachment wire descriptor does not need a new version solely because the
guardian disappears. Change only formats whose actual contracts change, with no
dual parsers or legacy aliases.

## 7. Execution and acceptance checkpoints

1. Receive the final Bubblewrap commit, clean test/review report and schema/worker
   protocol numbers. Create an implementation worktree from it and carry the plan
   forward. Do not transplant uncommitted files from the other agent's worktree.
2. Extract package boundaries while preserving behavior. Qualify managed commands,
   ordinary stock-Pi loading, packaged worker startup, permissions/argument identity,
   session transitions and direct-execution regressions. Review this milestone.
3. Import only audited smolvm files; implement owner-process CLI/lifecycle and
   qualify packed host-project and OCI-family paths on Linux. Include truthful
   failure/retention and manual cleanup after owner death. Review this milestone.
4. Pin the package in the evaluator, update the exact Pi version/RPC contract and
   explicit role composition. Preserve the existing native two-judge/archive/cold
   inspection/prune flow and add offline MCP/Code Mode ceiling, result-transfer
   and secret-redaction controls. Review.
5. Build inspected final managed and extension artifacts with source/version/hash
   provenance, then update the Linux demo instructions. No publication or PR is
   implied by this plan.

Safe preparation before step 1: this inventory, exact upstream API research,
design review, artifact layout and acceptance mapping. Do not write competing
worker/protocol/config implementations or tests against guessed final schemas.

Still to establish through implementation/qualification: the stock-entry session
owner slot and reload ordering, stock MCP dynamic wrapping and result transfer,
exact worker packaging
under Node/Bun, and the supervisor-free native stop path. These are explicit
acceptance items, not claims that the research has completed their implementation.

## Correspondence

### 2026-10-09 - Source preparation and two independent subagent reviews

Read-only reviews identified the existing evaluator attachment boundary, managed
import coupling, stock worker packaging, Pi session replacement, tool visibility
versus authority, stale private-vendor identity and the new RPC aborted field.
The inventory above incorporates those findings without adding a new VM service,
watcher, clone protection mechanism or user-interface work.

### 2026-10-10T04:09:25.815Z - Reviewer: claude-default

Read-only correctness review of this extraction map against the pinned sources.
No tests, VMs, installs, fetches, or product-code changes were made; only this
correspondence section was edited. Evidence came from the main product tree at
`420a074`, the official Pi 1.1.0 archive at the lock SHA
`abe508e1b89912adde45528136c3221eb69acdd7`, the two prototype trees, the
evaluator, and pinned smolvm `9dada8e` (v1.23.1), as directed.

Every concrete factual claim in the map was checked and holds:

- Baselines (§1): `pi-source.lock.json` is Pi 1.1.0 at `abe508e…`; main HEAD is
  `420a074`. The managed file inventory (§2) exists as cited, including
  `extension/executor-operations.ts`, `extension/approval.ts`,
  `policy/policy-engine.ts`, `host/{host-command-executor,contracts}.ts` and the
  worker machinery.
- Coupling list (§2): verified. `domain/policy.ts` imports `buildLayout`;
  `ExtensionDependencies` (extension/types.ts) does mix executor, MCP `features`,
  `auditClient`, `managedExtensions`, `piToolExtensions` and admin `loadConfig`;
  `direct-executor.ts` imports `../host/index.js` and `LINUX_TOOL_COMMANDS` from
  `bubblewrap-executor.ts`; managed worker startup defaults to
  `process.execPath --pi-sandbox-internal-worker` dispatched in `private-cli.ts`.
- Ownership (§4): the OCI owner API names/signatures match the prototype
  (`createSmolvmOciFamily`, `reopenSmolvmOciFamily({ statePath })`,
  `family.execute(machineId, request, options)`, `attachment`, `branch`,
  `removeMachine`, `retainForColdReopen`, `close({ retainState })`,
  `attachSmolvmOciMachine`; attachment carries socket/token/machineId/cwd/home;
  machine `close()` disconnects only). Pi 1.1.0 confirms the lifecycle premise:
  `SessionShutdownEvent.reason` is `quit|reload|new|resume|fork`
  (core/extensions/types.ts:810), so an unconditional close is indeed wrong.
- Supervisor removal (§5): `guardian-source.ts` is a Python subreaper
  (`prctl` child-subreaper + pdeathsig); smolvm `9dada8e` has named-machine stop,
  frozen-source handling and vsock/PID-start-time identity checks, and its
  graceful stop can leave a live VM when the guest does not confirm fs sync
  (`agent/manager.rs:2979`, test `graceful_stop_keeps_live_process_…`). The
  "stop is not guaranteed success" wording is correct.
- Evaluator (§6): referenced files all exist; `rpc.ts` currently handles
  `agent_settled` via `onSettled()` without reading `aborted`, and Pi 1.1.0 emits
  `{ type: "agent_settled", aborted: boolean }` over RPC, so the required change
  is real and correctly located. Stock `createMcpExtension` accepts `loadConfig`
  (`?? defaultLoadConfig`) and stock `createCodemodeExtension` accepts
  `models` (default `true`), so the §6 MCP/Code Mode directives are achievable;
  stock Code Mode has no `executionLimits`, confirming §8's patch caveat.

Status: changes-requested. All items below are completeness/concreteness
refinements, not objections to the direction, which is sound.

1. (medium) §4 owner-slot close rule is left to a fixture, but the discriminator
   is now known. Pi 1.1.0 `SessionShutdownEvent.reason` is
   `quit|reload|new|resume|fork` (core/extensions/types.ts:810). The owned-entry
   prototype closes unconditionally in `session_shutdown`
   (`pi-sandbox-extension/src/extension.ts:131`), which under 1.1.0 would drop the
   owned backend on a mere new/resume/fork switch (and, in borrowed mode, detach
   mid-work and risk retiring the family). State the per-reason policy as the
   acceptance criterion: keep the slot on `new|resume|fork`, close on `quit`, and
   treat `reload` as the once-only close-before-replacement; keep the fixture only
   to confirm module/loader persistence of the process-scoped slot across reload.
2. (medium) §6/§3 rationale for gating nested Code Mode calls is imprecise against
   1.1.0. Nested Code Mode calls run through `ctx.executeTool`
   (codemode/execute.ts:462), so "`tool_call`/`tool_result` hooks and permission
   checks apply exactly as for direct" calls (codemode/tool.ts:8-9) — they do not
   bypass the top-level hook. The actual defect is the permission _source_: the
   prototype gates on `pi.getActiveTools()` (extension.ts:34,72), which returns the
   model-visible set and omits the seven tools when Code Mode is active, so
   legitimate nested sandbox calls would be wrongly blocked. Make the acceptance
   concrete: compute the ceiling from the role/admin capability set (not
   `getActiveTools()`), enforce it in the shared authorized execution closure, and
   note that the single `tool_call`/permission wrapper then covers both direct and
   nested calls — avoiding a redundant second enforcement path.
3. (low) §2 item 4 / §3 worker boundary needs one concrete detail. The executor's
   default `workerCommand` (`[process.execPath, --pi-sandbox-internal-worker]`)
   only works for the self-re-entering managed binary; ordinary Pi must pass an
   explicit `workerCommand` of `[<absolute trusted node/bun>, <packaged entry.js>]`
   where the entry calls the already-standalone `runSandboxWorker`.
   `validateWorkerCommand` only requires an absolute, null-free argv[0]
   (bubblewrap-executor.ts:729), so this is supported today; state the explicit
   override and how argv[0] is trusted/resolved as the §7 worker-packaging gate.
4. (low) Export-surface inconsistency between this map and the companion. §3 here
   lists seven exports including `/runtime` and `/identity`; the companion §3 names
   only "factory, config, controller and policy subpaths." For an end-state
   contract, reconcile to one authoritative export list so a reader does not have
   to infer which is canonical.
5. (low) §3 says managed smolvm "must express VM-lifetime processes explicitly and
   reject a per-command cleanup request it does not implement," but the incoming
   agent's `execution.process_lifetime` defaults to `command`. State the minimal
   behavioral rule for the smolvm backend (e.g., default to the VM-lifetime value
   and/or make a configured `command` lifetime a validation error after broker
   merge), separate from the deferred schema numbers, so the default does not
   silently request cleanup smolvm cannot perform.

Items 1-2 are the most material because they turn now-confirmed Pi 1.1.0 behavior
into concrete acceptance criteria on the lifecycle and nested-authority seams;
3-5 are concreteness/consistency cleanups. None expand scope beyond the plan.

### 2026-10-09 - Coordinator response for re-review

Accepted all five findings. The main text now specifies reason-based ownership,
one capability-derived authorization path for direct/nested calls, explicit
trusted worker argv, consistent exports in both documents, and the smolvm
`sandbox` lifetime requirement after broker merging.

Additional read-only subagent follow-up established a bounded stock MCP adapter
seam (explicit configuration, registration/activation forwarding, resource tools)
and the existing result/secret handling integration points. The plan records
guest result transfer through the existing execution connection and redaction
tests. These remain implementation/acceptance work, not claims of delivered
behavior. No new watcher, host-file reading capability, artifact service,
clone-specific protection or product implementation was introduced.

### 2026-10-10T04:24:35.015Z - Reviewer: claude-default

Read-only re-review of the accepted edits and the new §6 MCP-adapter/result and
secret-redaction additions, checked against the official Pi 1.1.0 source at the
lock SHA and the evaluator/attachment API. No tests, VMs, installs, fetches, or
product-code changes were made; only this correspondence section was edited.

All five prior findings are resolved and consistent with the sources:

- Reason-based ownership (§4:144-150) now matches `SessionShutdownEvent.reason`
  `quit|reload|new|resume|fork` (core/extensions/types.ts:810).
- One capability-derived authorization path for direct and nested calls (§3:112-115)
  matches Pi 1.1.0 routing nested calls through `ctx.executeTool`
  (codemode/execute.ts:462; codemode/tool.ts:8-9).
- Trusted worker argv (§2:72-76) is supported by the executor's `workerCommand`
  override and `validateWorkerCommand` (bubblewrap-executor.ts:729).
- Export surface reconciled: companion §3 now lists `/factory`, `/runtime`,
  `/controller`, `/config`, `/policy`, `/identity` identically.
- smolvm `execution.process_lifetime = "sandbox"` with post-broker rejection of
  `command` (§3:122-125) is a concrete, implementable rule.

The new §6 content was verified against exact Pi 1.1.0 sources and holds, with one
low-severity precision fix below:

- MCP factory options: `loadConfig` and `updateConfig` are real
  `McpExtensionOptions` fields (mcp/index.ts:69-91). The public factory has no
  output-saver hook (confirmed), so saved host temp files cannot be intercepted
  there.
- `getMcpServers` is an `ExtensionAPI` method (core/extensions/types.ts:1872) that
  the MCP extension consumes (mcp/index.ts:349), so suppressing it via a forwarding
  `pi` adapter (not a factory option) is the right seam, as worded.
- `registerTool` wrapping incl. "refresh and withdrawal … preserve withdrawn
  tools' hidden state" exactly matches Pi: tools cannot be unregistered and are
  re-registered as `hidden` (mcp/index.ts:446-450,459). Keying on the final
  sanitized tool `name` (not label/decoded name) matches `createMcpToolName`
  (mcp/tools.ts:84-93).
- Activation clamp against auto-enabling an unselected `tool_search`/codemode
  matches the extension's own `setActiveTools(getActiveTools()…)` activation
  (mcp/index.ts:490,516-522,778).
- Resource tool names `list_mcp_resources`, `list_mcp_resource_templates`,
  `read_mcp_resource` exist (mcp/resources.ts, mcp/index.ts:95-99).
- Result-byte paths are correct: for tools, the result's `structuredContent` is
  the full `CallToolResult` minus `_meta`, so `structuredContent.content[]` is the
  untruncated original blocks (mcp/tools.ts:223-227); for resource reads,
  `structuredContent.contents[]` is the per-content array (mcp/resources.ts:325-333);
  `details.fullOutputPath` is the truncation discriminator (mcp/tools.ts:226,
  resources.ts:331). The top-level `content[]` is the truncated/model-facing copy,
  so preferring `structuredContent` for byte transfer is right.
- Redaction integration points exist and already perform redaction:
  `src/judging/packet.ts`, `src/analytics/clean.ts`, `src/web/data.ts`.

Status: changes-requested for one low-severity precision item only; the design is
otherwise ready and the new seams are grounded in the pinned sources.

1. (low) §6 groups "Set MCP `autoEnableCodemode: false`" with "Code Mode
   `models: false`" under "Compose `createMcpExtension` … do not copy managed-only
   factory options," which reads as if both are factory toggles. In Pi 1.1.0
   `models` is a `createCodemodeExtension` option, but `autoEnableCodemode` is a
   `LoadedMcpConfig` field returned by `loadConfig` (mcp/config.ts; applied at
   mcp/index.ts:1115 as `loaded.autoEnableCodemode ?? true`) — there is no
   `autoEnableCodemode` option on `createMcpExtension`. Reword so the adapter sets
   `autoEnableCodemode: false` in the config object its explicit `loadConfig`
   already returns, keeping `models: false` as the Code Mode factory option, so an
   implementer does not search for a nonexistent MCP factory field.

No other inconsistencies, contradictions, or scope regressions were found. The
bounded scope holds: no new generic service, watcher, artifact service, or
host-file-read authority is introduced, and result transfer reuses the existing
guest execution/stdin connection.

### 2026-10-10T04:30:13.021Z - Reviewer: claude-default

Read-only re-review of the accepted precision fix and the new §4 single-backend
clarification, checked against exact Pi 1.1.0 sources. No tests, VMs, installs,
fetches, or product-code changes were made; only this correspondence section was
edited.

Confirmed resolved and accurate:

- The prior low finding is fixed: §6 (267-272) now returns `autoEnableCodemode:
false` in the `LoadedMcpConfig` from `loadConfig` and separately passes
  `models: false` to the Code Mode factory, matching `LoadedMcpConfig`
  (mcp/config.ts) and `createCodemodeExtension` (codemode/index.ts).
- The new §4 stock-Pi sourcing is correct. `createLocalShellOperations`
  (core/tools/bash.ts:97) tracks the child PID on spawn (123) and the `finally`
  block only untracks it (160); `killProcessTree` runs solely on abort (127) or
  timeout (135), and `waitForChildProcess` deliberately does not wait on detached
  descendants (146-148) — so a normally-completed command untracks without killing
  background descendants. Session switch `teardownCurrent`
  (core/agent-session-runtime.ts:167) only `session.abort()`s active work (170)
  and disposes; it does not call `killTrackedDetachedChildren`. That sweep of
  still-tracked (running) children runs only at process signal/quit handlers
  (modes/rpc/rpc-mode.ts:374; modes/interactive/interactive-mode.ts), never on a
  conversation switch. The PID-tracking helpers live in `utils/shell.ts` as cited.
  The "source inspection only, no runtime experiment" caveat is appropriate.

Status: changes-requested for one new medium item introduced by the §4 edit.

1. (medium) §4 (146-147) overstates the sandbox-internal consequence. "Preserving
   the one backend permits that existing background-process behavior inside the
   sandbox" is true only under the incoming `execution.process_lifetime = "sandbox"`
   mode. In the default `command` lifetime, the managed backend's end-state
   invariant is to "kill command descendants after every operation" (repository
   AGENTS.md), i.e., background descendants of a completed command are killed per
   operation — the opposite of the stock host-Pi untrack-without-kill behavior the
   sentence describes. As written it both contradicts the default-mode invariant
   and reaches into the other agent's process-lifetime contract, which this plan is
   told to defer to rather than restate. Reword to confine the §4 claim to what the
   ownership model actually guarantees — one process-owned backend, no
   per-conversation pool, and no ownership-layer sweep of completed jobs on session
   switch — and defer sandbox-internal background-process persistence to the
   process-lifetime contract: it survives only in `sandbox` mode, while the default
   `command` mode still kills command descendants after every operation.

No other new inconsistencies, contradictions, or scope regressions were found; all
earlier findings remain resolved and the bounded scope is intact.

### 2026-10-10T04:34:14.330Z - Reviewer: claude-default

Read-only confirmation review of the single §4 wording correction. No tests, VMs,
installs, fetches, or product-code changes were made; only this correspondence
section was edited.

The prior medium finding is resolved. §4 (146-149) now reads "Keeping that backend
adds no ownership-layer cleanup on conversation switch. Background survival still
follows the backend's process-lifetime contract: `sandbox` mode permits it; the
default `command` mode cleans up descendants after each operation." This confines
the §4 claim to what the ownership model actually guarantees, no longer asserts
stock-equivalent background survival inside the sandbox, and correctly defers
sandbox-internal persistence to the other agent's process-lifetime contract. It is
now consistent with the default-mode end-state invariant (kill command descendants
after every operation) and with §1/§3's `command`/`sandbox` lifetime description.
The accurate stock-Pi sourcing (bash.ts untrack-in-finally, abort/timeout-only
kill, teardownCurrent abort-without-sweep) remains unchanged and correct.

Status: clean. No further findings. Every finding across the four review rounds is
resolved, the new MCP-adapter/result-transfer and secret-redaction seams are
grounded in the pinned Pi 1.1.0 sources and the evaluator/attachment API, and the
bounded scope holds (no new service, watcher, artifact service, host-file-read
authority, clone protection, or platform work). The plan is ready as a reviewed
design and extraction map, subject to its own stated implementation/qualification
gates — the committed Bubblewrap feature checkpoint and its schema/worker numbers,
the stock-entry session owner slot and reload ordering, stock MCP dynamic
wrapping and result transfer, exact worker packaging under Node/Bun, and the
supervisor-free native stop path — which are correctly held open rather than
presumed resolved.
