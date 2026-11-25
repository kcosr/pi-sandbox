# Workspace modes and shared audit policy

Status: implementation contract for managed configuration schema 15.

This document records the design and acceptance criteria for workspace modes.
The maintained product contract is in the subject documents under docs/.
Modes are administrator-defined overlays; there is no mode-less launch, special
system mode or mode-owned audit configuration.

## Intent

Let administrators offer named workspace configurations that users select when
launching Pi Sandbox. Common settings remain at the top level. A mode supplies
only its explicit overrides, and every launch resolves exactly one complete mode.

The two example configurations are:

| Example mode | Host CWD  | Model Bash, write, edit                    | User file export |
| ------------ | --------- | ------------------------------------------ | ---------------- |
| host         | Writable  | Ask for each invocation; no session grants | Disabled         |
| sandbox      | Read-only | Allow without approval prompts             | Enabled          |

These names and policies are administrator-authored, not built-in permission
presets. Existing account/group overrides apply after the selected mode and may
change the final policies. Diagnostics must describe that final behavior.
The word host does not select the direct backend; both examples normally use the
same configured Bubblewrap or Seatbelt backend.
Packaged policies retain their backend-specific restrictions: Seatbelt keeps
Bash disabled in both modes, and direct offers only host with Bash disabled.
The packaging section specifies those defaults separately from these examples.

Mode selection does not create a new sandbox, copy the project into scratch,
change the launch directory, or grant a model an export capability.

## Scope and ownership

- Common tool invocation policy stays under `tools`.
- Application-wide audit configuration stays under `audit`. Named-tool logging
  moves from each tool's policy to an exhaustive `audit.tools` Boolean map.
- Mode selection and definitions live under `workspace`, with `default`,
  `allowed`, and `modes`.
- Mode overlays may contain only `filesystem.cwd_writable`, `exports.enabled`,
  and invocation policies for `bash`, `write`, and `edit`.
- Root-managed Linux user/group rules may override the allowed mode list and
  default mode, alongside the existing broker override fields.
- Execution backend, network, host visibility, models, environment, MCP,
  extension selection/settings, Git destination, subagent admission/quotas,
  skills and retention retain their existing ownership. They are not mode
  overlay fields.
- This changes the managed application, not ordinary Pi's standalone extension
  configuration. No new Pi patch or public executor capability is required.

There is no saved personal mode preference, project-defined mode, runtime mode
switch, inter-mode inheritance, or general-purpose configuration profile loader.
The user CLI selects only an administrator-admitted definition. Account rule
files remain administrator-owned; they are not editable personal preferences.

## Authored schema and versions

The main schema is 15, user/group rule version is 11, and identity broker
wire protocol is 11. Audit transport wire 5 and record schema 6 remain unchanged.
All versioned readers, including the Rust audit collector's main-config reader,
must be updated together. No aliases, dual parsers or silent conversion of old
versions are included.

### Workspace selection and definitions

`workspace` is required and accepts exactly these fields:

| Field     | Requirement                                                                 |
| --------- | --------------------------------------------------------------------------- |
| `default` | Required mode identifier                                                    |
| `allowed` | Required array of distinct mode identifiers; the main list must be nonempty |
| `modes`   | Required map of 1–32 mode definitions                                       |

Identifiers match `^[a-z][a-z0-9_-]{0,31}$`, are case-sensitive, and have no implicit
normalization. Lists contain at most 32 entries; duplicates, invalid identifiers
and unknown fields are errors. Every identifier in the main allowed list and the
main default must exist in modes. The main default must be in the main allowed
list. Definitions outside that list are permitted so account/group rules can
grant access to them.

Host and sandbox are examples, not reserved identifiers. A mode may be an empty
table, explicitly inheriting all common values. There is no implicit system
definition or mode-less bypass.

Each mode may also have a main-authored description: a nonblank single-line
string of at most 256 UTF-8 bytes, with no control/format characters or Unicode
line/paragraph separators. Preserve its text unchanged for display. Description
is informational metadata, not an invocation policy or broker-overridable field.
If omitted, display the name without inventing a description.

Every definition is structurally and statically validated, including definitions
not in the main allowed list. A caller-selected mode cannot rescue an invalid
main configuration or an invalid effective default.

The main configuration source is limited to 1 MiB (1,048,576 bytes), matching the
audit collector's existing limit. All application entry points that read or
validate main configuration enforce this bound before TOML parsing, even with
auditing disabled. Bound the file read itself, including a file that grows while
being read. Existing per-table command-set and broker response bounds remain.

### Partial common values and overlay semantics

Mode-owned values may be omitted at the top level. For example, the common
filesystem table can contain only hidden_paths and denied_paths, with every
mode supplying cwd_writable. The exports table may be absent if every mode
supplies enabled; if present, it must contain Boolean enabled, so an empty
top-level exports table is rejected. The common tools table may omit
bash/write/edit entries if every mode supplies those policies.

Other required common values and policies remain required. An optional field
keeps its existing documented default; this feature does not invent defaults for
required permissions, CWD writability, exports or logging.

Validate every authored common and mode entry independently for type, keys,
local bounds and internal consistency, even if a mode replaces that common entry.
For example, session_grant = "offer" requires mode = "ask"; a Bash class must be
strictly more permissive than its enclosing Bash policy; command-set grammar
must be valid. Snapshot-wide authoring checks cover the mode inventory and
selection metadata, exhaustive audit map, aggregate bounds and command-set ID
consistency. Effective cross-entry and cross-table policy checks run on each
composed mode, not on the partial common input as a separate launchable
configuration. Thus
individually valid common CWD/export values may be incompatible with each other
if every mode replaces enough of them to form a valid configuration. A malformed
common entry is still rejected even when every mode replaces it. Composed-mode
errors name the mode and the originating common or mode paths for the relevant
values.

Each definition accepts only the following paths:

| Mode entry    | Merge rule                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `description` | Optional display metadata; never merged into execution policy                                         |
| `filesystem`  | If present, contains exactly Boolean `cwd_writable`; replace this leaf                                |
| `exports`     | If present, contains exactly Boolean `enabled`; replace this leaf                                     |
| `tools`       | If present, contains one or more of bash/write/edit; replace each supplied complete invocation policy |

The definition itself may be empty; present nested tables must not be empty.
All other fields are errors, including audit, hidden/denied paths, backend,
network, arbitrary tool names, MCP or another mode selector.

A supplied invocation policy requires mode and session_grant and follows the
existing policy value and Bash exception validation. Audit is not an invocation
field. For Bash, the optional known_read_only and command_sets fields belong to
the complete replacement: omitting them removes the common exceptions for that
mode. They are never accidentally retained through a recursive field merge.
Command-set definitions remain main-authored and cannot be changed through
broker rules. The known_read_only class retains its existing user/group override
support; those account policies apply after mode composition.

Within one main-configuration snapshot, every occurrence of a command-set ID
across the common Bash entry and all mode Bash entries must describe the same
rule. Check all authored entries, including replaced common values and disallowed
modes. Compare normalized parsed rules: scalar and singleton-array commands are
equivalent, absent optional collections become empty, and unordered command,
flag and literal-value arrays and option keys are sorted in non-locale UTF-16
code-unit order for comparison. Reject invalid duplicates before normalization;
preserve exact string spelling. Include
option kinds, operand bounds and invocation values in equality. Do not resolve
paths or infer equivalence between different spellings or predicates. Reject a
conflict with both configuration paths; different rules need distinct IDs.
This adds no cross-file registry or global command-set count limit.

Common values are defaults rather than a permission ceiling. An authorized mode
can replace a common ask/deny/disabled invocation entry with allow for one of
these three existing tools. It cannot add compiled tools or extensions. CLI
tool exclusions, optional-extension admission and the existing managed boundary
continue to apply.

After composing a mode, its policies must pass ordinary semantic validation,
including known-read-only prerequisite tool policies and backend/filesystem/export
compatibility. A mode name alone does not impose a fixed approval invariant.

### Audit separation

Main `audit` contains the existing enabled and facility fields plus required
`tools`. This map has exactly one explicit Boolean for every named tool policy
subject in the configured managed catalog:

- Include all seven built-in subjects, even those whose invocation mode is
  disabled or whose tools are excluded by the CLI.
- Include tools contributed by configured optional extensions, such as
  git_clone, even if a user preference hides the extension.
- Include the single subagents subject when subagents are administratively
  enabled; do not list the five individual management operations.
- Do not include unconfigured extension subjects, user_shell, codemode or
  dynamically discovered MCP tools.

Missing, unknown or non-Boolean entries fail validation even when global auditing
is disabled. Mode changes never change this catalog or its audit map.

Named invocation entries at root and in modes must reject the obsolete audit
field. The resolver attaches the common audit Boolean to the existing effective
ToolPolicy representation; runtime authorization and audit transport semantics
stay unchanged. Broker tool overrides still preserve those common choices.

MCP default_policy and tool_rules retain their existing audit fields and
original-tool matching semantics. MCP auditing is not moved into audit.tools.
Session-event logging and the fixed exclusion of human ! commands stay unchanged.

Audit records do not identify the selected workspace mode. The command-set ID
consistency rule keeps configured-command evidence unambiguous within one main
configuration snapshot, but IDs are not versioned across policy revisions or
deployments. Records alone cannot identify which workspace mode permitted a
tool invocation. These are explicit limitations of retaining the audit schemas.

### Example main configuration

This complete Linux example retains the packaged backend and baseline tool
permissions, supplies CWD/export values in each mode, and offers both choices.
It uses disabled identity resolution; enabling broker mode is required before
the account/group examples below take effect.

```toml
# Managed configuration schema 15.
config_version = 15
models_file = "/etc/pi-sandbox/models.json"

[codemode]
enabled = false

[mcp.servers]

[skills]
directories = []

[sessions]
retention_days = 365

[audit]
enabled = false
facility = "local0"

# Logging stays common to every workspace mode.
[audit.tools]
read = false
grep = false
find = false
ls = false
write = true
edit = true
bash = true

# Shared filesystem values; modes supply CWD access.
[filesystem]
hidden_paths = []
denied_paths = []

[execution]
backend = "bubblewrap"

[identity]
mode = "disabled"

[network]
mode = "none"

[environment.pi]

[environment.sandbox]

[environment.extensions]

[extensions]

# Shared invocation policies; modes may replace bash/write/edit.
[tools.read]
mode = "allow"
session_grant = "never"

[tools.grep]
mode = "allow"
session_grant = "never"

[tools.find]
mode = "allow"
session_grant = "never"

[tools.ls]
mode = "allow"
session_grant = "never"

[tools.write]
mode = "ask"
session_grant = "never"

[tools.edit]
mode = "ask"
session_grant = "never"

[tools.bash]
mode = "ask"
session_grant = "never"

[workspace]
default = "host"
allowed = ["host", "sandbox"]

# Host inherits the shared ask/never tool policies.
[workspace.modes.host]
description = "Work in the host project with approval for changes."

[workspace.modes.host.filesystem]
cwd_writable = true

[workspace.modes.host.exports]
enabled = false

[workspace.modes.sandbox]
description = "Work in temporary storage and explicitly save deliverables."

[workspace.modes.sandbox.filesystem]
cwd_writable = false

[workspace.modes.sandbox.exports]
enabled = true

# Each entry replaces the complete invocation policy.
[workspace.modes.sandbox.tools.write]
mode = "allow"
session_grant = "never"

[workspace.modes.sandbox.tools.edit]
mode = "allow"
session_grant = "never"

[workspace.modes.sandbox.tools.bash]
mode = "allow"
session_grant = "never"
```

The host mode inherits ask/never. Sandbox replaces the three invocation entries
with allow/never. Neither changes logging. Setting audit.enabled to false still
disables actual collection in both modes.

## User/group mode-selection overrides

An administrator-managed rule may add:

```toml
version = 11
user = "alice"

[overrides.workspace]
allowed = ["sandbox"]
default = "sandbox"
```

A group or numeric selector uses the existing selector rules. Workspace accepts
only allowed and default, with at least one present. Neither is required
individually. Empty workspace tables, definitions under the override, audit
changes and unknown fields are rejected. Existing tool/filesystem/backend/etc.
override rules remain available with their existing shapes and merge behavior.

### Combining matching rules

| Input                                    | Behavior                                                             |
| ---------------------------------------- | -------------------------------------------------------------------- |
| No matching explicit allowed list        | Inherit the main allowed list                                        |
| One or more explicit allowed lists       | Union only those explicit lists, then replace the main allowed list  |
| Explicit empty list                      | Contributes no grants; an all-empty union denies operational startup |
| No matching explicit default             | Inherit the main default name                                        |
| Matching defaults all name the same mode | Use that name                                                        |
| Matching defaults name different modes   | Configuration error                                                  |

User and group rules have equal precedence; filenames do not establish ordering.
A restrictive list cannot revoke a mode granted by another matching rule. The
main allowed list is a default, not a ceiling. The main mode inventory is the
definition boundary: rules cannot grant undefined modes.

The effective default must exist and belong to the effective allowed list even
when the CLI specifies another mode. An empty effective allowed list therefore
has no valid operational launch; it does not fall back to the common policy.
Administrators narrowing access must also change the default when needed.
Overlapping groups with different explicit defaults prevent launch for their
shared members; neither a user rule nor a CLI selection breaks that conflict.
Assign defaults only where matching memberships agree or cannot overlap.

All rule files are structurally validated, including unmatched records.
As with current MCP IDs, the broker need not read the application's main mode
inventory: the application validates all names in the combined matching patch
against that inventory. Structurally valid unknown names in unmatched rules are
checked if those rules later match.

The wire patch adds an optional workspace object with optional allowed/default,
preserving omitted versus explicitly empty allowed. Canonicalize union lists to
distinct identifiers sorted in ascending ASCII order. Duplicate identifiers
within one rule file's allowed array are structural errors, including in
unmatched files; reject them before set conversion. Overlapping grants across
different matching files are deduplicated by the union. The client rejects
duplicate or non-canonical wire lists. Apply identifier/list limits to each
record and the combined patch, retain the existing total response bounds, and
reject old protocol versions and extra fields. A partial wire workspace must
also be nonempty. Do not send mode definitions, audit choices or a selected mode
in the broker request; identity remains kernel-authenticated.

The broker owns allowed-list union, default equality and combined-patch bounds.
Merge failures retain its existing identity_store_unavailable response; no new
wire error code or disclosure of conflicting account rules is added. The
application owns inventory lookup, empty effective allowed lists,
default-in-allowed checks and CLI permission checks. Report these as distinct
configuration/selection errors. Default errors identify the effective default;
an empty-list error explicitly says no mode is selectable. A rejected requested
mode reports only effective selectable names, not the rest of the inventory.
No failure silently selects another mode.

## Startup and validation pipeline

Introduce separate authored and effective configuration types. Partially
specified common input must never reach an executor, policy engine or managed
extension as if it were an effective policy.

1. Enforce the main source bound; parse strict main structure and all authored
   entries, and validate snapshot-wide command-set ID consistency.
2. Compose each mode with common input. Validate completeness and pure
   cross-field constraints for every mode, including modes outside allowed.
   Attach the common named-tool audit map to each resolved policy.
   Preserve current-platform checks through assertExecutionPlatform on the
   composed main configurations before any broker access: reject unsupported
   operating systems/backends and require identity and audit disabled on macOS.
   These checks also run during installation validation and backend queries.
3. Resolve the existing authenticated identity/environment patch. Combine
   workspace selection overrides with the main allowed/default fields.
4. Validate effective mode-selection metadata. Choose the explicit CLI name,
   or the effective default if there was no flag. Verify permission and lookup.
5. Take that composed mode, then apply the remaining existing broker overrides
   once. Retain their current least-restrictive/conflict rules and Bash
   command-set preservation semantics.
6. Validate the final configuration and recheck the current platform after broker
   overrides, which may change execution/network/filesystem values. Expand effective
   account/macros and environment references through the existing lifecycle,
   and validate actual launch-CWD and trusted-path prerequisites.
7. Construct the analyzer, executor, host tools, exports and shared approval
   engine from that immutable effective configuration.

Mode selection and ordinary broker policy are separate phases, not two merges of
the same invocation overrides. No mode patch is reapplied after broker policy.
An explicit broker ask can keep a tool prompted in sandbox mode; a broker allow
can relax a host example's approval. Such valid differences do not fail merely
because they differ from the mode's name. A broker writable CWD with enabled
exports remains invalid and fails startup.

Static validation does not resolve secret files, expand an arbitrary user's
identity, query hardware identity, connect MCP, probe executors, or inspect
hypothetical launch directories for every mode. Existing installation/model/
skill checks retain their normal scope. Actual account-specific and filesystem
checks run for the selected final configuration only.

Existing static and runtime guards remain effective: exports require a confined
backend and read-only CWD, direct requires host networking and writable CWD,
platforms constrain their backends and exclusions, command-path directories
cannot overlap writable grants, and Bubblewrap read-only CWD cannot equal /tmp.
An incompatible selection never changes backend or chooses another mode.

## CLI, lifecycle and diagnostics

The managed launch prefix is:

```text
pi-sandbox [--config FILE] [--workspace-mode NAME] [Pi arguments...]
```

The existing build gate and leading position of --config are preserved.
Workspace mode accepts a separate value or --workspace-mode=NAME, once,
after optional --config and before Pi arguments. Missing/empty/invalid names,
duplicate flags and misplaced launch-prefix options are errors. Detect later
--config and --workspace-mode tokens with the pinned value-option scanning rules
already used by managedArguments; align the existing --config scan with those
rules. Unconditionally consumed Pi option values are skipped even when they
start with a dash; a consumed -- value is not the end-of-options marker. Do not
treat Pi's conditional-value options as unconditionally consuming the next token.
Stop at a real -- marker and leave subsequent text untouched. Embedded text in
a positional prompt is not a selector, but a separate selector token before --
is misplaced. --enable-extension and --disable-extension retain their existing
positions; the new prefix restriction applies only to --config and
--workspace-mode. Consume the selector before forwarding arguments to Pi.

Pi's --mode rpc continues to select the interface and is unrelated to workspace
mode. The mode applies in TUI, RPC, print and JSON operation, but exports remain
TUI-only. Required approvals continue to fail closed when the interface cannot
answer; no new RPC approval or export capability is introduced.

Operational launches always select a mode. Exact --version remains metadata-only
and independent of configuration, identity and CWD. --validate-installation and
--print-execution-backend validate every main-authored mode without resolving a
caller identity or selecting an account default, including the current-platform
checks in step 2. They reject wrong-OS backends and macOS broker/audit enablement
before installation can proceed. The backend query returns the shared authored
backend, since modes cannot override it. Reject combining an
explicit workspace selector with those metadata/installation operations or
private worker/export-reader entry points. Existing root-user and private-entry
guards remain intact. Help describes mode syntax and its configured/default
semantics without adding a saved preference.

`--list-workspace-modes` lists only the caller's effective allowed modes, sorted
by identifier, with their administrator descriptions and an explicit effective
default marker. It accepts only the optional leading --config prefix; reject
duplicates, a workspace selector or other Pi/metadata/private arguments together
with listing. It uses strict all-mode main validation, current-platform guards
and existing authenticated identity resolution, then validates effective allowed
and default metadata. It does not start a model session, load models, connect
MCP or start an executor, and does not resolve main environment file references,
account path macros or runtime CWD prerequisites. Broker resolution retains its
existing rule/environment semantics. Preserve the operational root-user guard.
Listing is an explicit plain-text CLI result, not an RPC command or saved
preference. Help documents it.

Selection is fixed for the process. Conversation replacement, reload, session
resume/fork and executor recreation retain the captured effective mode and
configuration. A new process that resumes a conversation resolves current policy
and its own CLI/default anew; session content is never authority for mode
selection. Existing grant-reset and scratch-lifetime rules are preserved.

Managed children share the parent's effective tool registry, executor and
approval/grant scope. They cannot choose another mode. Save/exit behavior keeps
existing child quiescence and export authority checks.

Add selected mode, selection source (CLI or default) and effective export state
(disabled or enabled, TUI-only) to the /sandbox summary beside its existing
effective CWD access. Include the selected mode's description when present.
/sandbox mounts continues to describe the final filesystem;
/sandbox policy continues to show the final post-broker invocation policies and
session grants. Do not claim that a mode name guarantees approval settings.

Add no startup banner or automatic stdout/stderr notice in any interface.
Print, JSON and RPC streams remain unchanged except for explicitly requested
diagnostic responses. Wrapper help explains the selector, configured default
and terminal-only exports. Keep the model environment prompt based on final
CWD/home/scratch behavior; do not add the arbitrary mode name or selection
source, or suggest that the model can export files.

## Security and platform boundaries

- The root administrative mode inventory, allowed/default decisions and compiled
  catalog control selection. No user state, environment or project file supplies
  definitions or broadens access.
- Mode overlays cannot replace hidden/denied paths, backend, networking, audit,
  MCP policy, tool bundles or any other excluded field.
- An approved/allowed tool still runs under the configured backend. Approval
  never makes read-only CWD writable.
- Human ! shell remains fixed-allow under that same backend.
- Host MCP and Git retain their separate authority. Git host_cwd can still write
  host CWD even when sandbox tools see it read-only. This feature is not a
  blanket guarantee against every host write.
- Git destination remains main-only, outside mode overlays and outside new
  broker fields. Sandbox Git import and Seatbelt behavior are unchanged.
- Exports remain explicit user-directed publication with replacement review,
  existing bounds, audit behavior, cancellation and exit semantics. No automatic
  retention or new noninteractive exporter is added.
- Audit records retain their current schemas and do not attribute decisions to
  workspace modes. Command-set IDs have consistent definitions within one main
  snapshot only; retained policy versions are still needed to interpret historic
  configured-command evidence.
- Linux Bubblewrap and macOS Seatbelt can support the example sandbox mode.
  Direct supports only definitions that resolve to writable CWD and disabled
  exports. Do not include an incompatible read-only/export mode in a direct
  installation, even as a disallowed definition.
- macOS continues with identity disabled and audit disabled. Mode selection
  still works from main policy, but no macOS account/group broker is introduced.

## Migration, packaging and implementation boundaries

Require main schema 15, rule version 11 and identity wire 11 as one coordinated
upgrade. The audit collector must accept the new main schema and validate the
new tools map structurally while retaining its existing process authority.
Application and collector share the new main file; deployed broker rules must
also be updated. Keep audit wire 5 and record schema 6.

For existing deployments preserving their exact policy:

1. Change the main schema version and move every named tools.<subject>.audit
   Boolean into audit.tools, removing the old fields. Keep MCP auditing in place.
2. Keep current common filesystem/export/tool values. Add one administrator-named
   empty mode (for example host), and use it as the sole allowed and default mode.
   This gives the prior effective configuration a mode without changing policy.
3. Update user/group rule versions. Existing rules may omit workspace and inherit
   selection metadata; otherwise author allowed/default explicitly.
4. Before adding another mode, review existing account/group cwd_writable and
   Bash/write/edit overrides, which apply to every selected mode. A matching
   cwd_writable = true makes exports-enabled modes invalid for that account;
   tool overrides can replace the intended per-mode approval differences. Move
   differences into mode definitions and account mode grants where that is the
   intended policy, removing obsolete overlapping overrides explicitly.
5. Add other modes and grants deliberately, after validating their resolved
   configurations and account combinations.

Installers must reject old/incomplete retained main configuration before swapping
binaries, with actionable version/field diagnostics. Their existing candidate
checks do not preflight the broker rule store. Administrators must migrate rule
versions before activating the upgraded broker, which rejects an old-version
rule store at resolution time. No new offline broker-store validator is added.
Do not automatically rewrite policy or infer a mode from CWD writability. Update
both Linux and macOS candidate validation, default configurations, smoke fixtures
and documentation.

Packaged policies for fresh installations retain their present backend and
default host behavior. Every invocation policy below uses session_grant = "never";
existing common audit choices are preserved.

| Packaged file                       | Allowed/default      | Host mode                                                | Sandbox mode                                               |
| ----------------------------------- | -------------------- | -------------------------------------------------------- | ---------------------------------------------------------- |
| config/default/config.toml          | host, sandbox / host | Writable CWD, exports off, Bash/write/edit ask           | Read-only CWD, exports on, Bash/write/edit allow           |
| config/default/config.seatbelt.toml | host, sandbox / host | Writable CWD, exports off, Bash disabled, write/edit ask | Read-only CWD, exports on, Bash disabled, write/edit allow |
| config/default/config.direct.toml   | host / host          | Writable CWD, exports off, Bash disabled, write/edit ask | Not defined                                                |

The Bubblewrap policy matches the complete Linux example. Seatbelt's sandbox
overlay supplies only CWD, exports, write and edit, retaining its disabled common
Bash policy. Administrators can explicitly author other valid invocation choices;
the new packaged mode does not enable Bash on Seatbelt. Existing deployments keep
their single migrated mode until administrators add definitions and grants;
installers must not replace retained policy with the fresh-install choices.

Implementation should keep the resolver pure through static mode composition,
reuse existing effective runtime contracts, and change only the managed policy
authoring/resolution boundary. Review these areas:

- src/config, src/domain, src/runtime/config-arguments.ts and src/runtime/main.ts.
- src/identity/client.ts and broker/src/main.rs for bounded selection metadata.
- audit-collector/src/main.rs and main-config readers/install validation.
- src/extension diagnostics and managed subagent/runtime reuse.
- Packaged policies, fixture generators and the relevant release smoke suites.

Update docs/configuration.md, docs/identity-broker.md, docs/security.md,
docs/architecture.md, docs/installation.md and docs/testing.md when behavior is
implemented, plus specs/pi-integration.md (the authoritative integration contract),
the README launch-prefix text, a concise Unreleased changelog entry and applicable
AGENTS.md version/ownership invariants. Do not describe this proposed feature as
already implemented in current-state documentation.

## Acceptance criteria

All behavioral verification is offline; no live model-provider calls.

### Configuration and composition

- Parse the full example and resolve host/sandbox to the documented values.
- Accept common omissions only when every defined mode supplies complete policy.
  Reject a missing field in any mode, including an unselected/disallowed one.
- Accept an absent common exports table when every mode supplies enabled; reject
  an empty present common exports table even when every mode supplies enabled.
- Accept an empty mode inheriting a complete common configuration.
- Reject an invalid authored common entry even if all modes replace it. Accept
  individually valid but mutually incompatible common values when every composed
  mode is valid; reject any incompatible composed mode with its name and value
  provenance in the diagnostic.
- Reject unknown keys, invalid IDs, duplicate/oversized lists and unknown names.
- Accept optional bounded descriptions, reject empty/oversized/control-containing
  descriptions, and preserve literal text without using it as authority.
- Accept a valid main source of exactly 1,048,576 bytes; reject one byte more in
  application and collector readers, including audit-disabled installation
  validation. Bound reads of growing files.
- Reject mode attempts to change audit, hidden paths, execution, MCP, Git
  settings, arbitrary tools, selection metadata or another mode.
- Exercise complete Bash policy replacement: no inherited class/session grant or
  command-set exception after a mode omits it. Preserve a supplied valid
  exception and retain existing class preconditions and command-set validation.
- Accept equivalent normalized definitions for one command-set ID across common
  and mode Bash entries; reject different rules sharing an ID, including unused
  common entries and disallowed modes. Preserve command_set_ids evidence and
  audit schemas across modes without adding a selected-mode record field.
- Require exact named-tool audit coverage, including disabled or user-hidden
  subjects; reject old audit locations. Test optional Git/subagents inventory.
  Preserve MCP per-rule audit and the runtime audit decision/record contract.
- Validate exports/backend/CWD combinations in every definition without secret
  resolution or external runtime probes.

### Identity and authorization

- Test main inheritance, one explicit list, union across user/group rules,
  empty lists, unknown names and combined bounds.
- Reject duplicate allowed identifiers within a single rule file, including an
  unmatched one. Deduplicate overlapping grants across distinct matching files
  into canonical sorted wire lists; reject duplicate or unsorted lists in the
  client.
- Test default inheritance, identical and conflicting explicit defaults, and
  a forbidden/missing default even with an otherwise permitted CLI choice.
- Assert broker union/conflict/bounds failures retain identity_store_unavailable,
  including overlapping groups with conflicting defaults; application inventory,
  empty-list, default and forbidden-selection failures have distinct diagnostics.
- Demonstrate that main allowed is a default and definitions are the boundary.
- Structurally reject invalid unmatched rule files; reject matching unknown
  inventory IDs without adding main-inventory reads to the broker.
- Test omitted versus empty allowed through the real broker protocol.
- Preserve current tool, environment, backend and network joins after selection.
  Exercise valid account ask/allow changes and invalid writable-CWD/export
  results. Keep session grants and logging ownership unchanged.
- Reject old protocol/rule versions, unknown wire fields and unbounded output.

### CLI and lifecycle

- Test default, explicit and equals-form selection; missing/duplicate/misplaced
  flags; optional leading --config; -- boundaries; Pi option-value text;
  unknown/forbidden modes and unchanged Pi --mode rpc.
- Reject selector-before-config ordering and separate selectors after Pi args.
  Treat --system-prompt --workspace-mode=sandbox as an option value and
  -- --workspace-mode=sandbox as prompt text. Treat --name -- followed by a
  separate selector as misplaced: that first -- is a consumed value. Cover the
  aligned --config scan and retain optional-extension switch positioning.
- Preserve exact --version independence, root checks, private entry points and
  full candidate/backend-query validation. Explicit mode cannot reduce
  installation validation to one definition.
- Test all-mode static validation versus selected-mode runtime checks.
- Reject wrong-OS backends and macOS broker/audit enablement before broker IPC;
  for example, macOS broker mode reports its platform error without dialing a
  socket. Both installation validation and backend queries reject those same
  invalid main configurations. Recheck platform constraints after broker policy.
- Demonstrate fixed selection across session switches, reload and executor
  recreation; new-process resume re-resolves policy. Child tools inherit
  permissions and shared approvals without mode selection of their own.
- Preserve terminal export/exit flows and their child quiescence; RPC/print/JSON
  do not gain save capabilities or human output in machine-readable streams.
- Verify /sandbox mode/source/export rows and effective CWD, mounts and policy
  after broker overrides. Forbidden-selection errors list only effective allowed
  names. Keep normal stdout/stderr streams and model mode-label omission intact.
- List only effective allowed names/descriptions in sorted order and mark the
  effective default after account overrides. Cover absent descriptions, invalid
  selection metadata, incompatible/duplicate listing arguments, root checks and
  listing without model/session/MCP/executor or main environment-file startup.
  Verify the selected description appears in /sandbox without entering the
  model prompt or changing effective policy.

### Both consumers and deployment

- Resolve every packaged policy/mode to the table above and show each default
  retains its prior effective policy. Migrate each current schema-14 packaged
  policy through steps 1–3 and demonstrate effective-policy equivalence. Both
  Linux and macOS installers reject retained schema-14 input before binary swap.
- Unit, identity integration and native backend tests cover host write approval
  and read-only sandbox work plus explicit export.
- Qualify the compiled managed application, real Bubblewrap, installers,
  collector parsing and package/release smoke; preserve mandatory builder
  verification checkpoints.
- Qualify Seatbelt behavior on each supported macOS architecture separately;
  reject incompatible direct configurations with no backend substitution.
- Run appropriate standalone package acceptance to show the shared executor and
  ordinary Pi consumers retain their existing contracts.
- Inspect/rebuild final artifacts from the final source revision for any later
  release. Implementation verification does not itself authorize a release or deployment.
