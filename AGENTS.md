# Repository agent guide

This project provides a policy-gated execution boundary in a managed Pi
distribution. Linux supports Bubblewrap and explicit direct execution;
macOS packages select Seatbelt execution by default and support explicit direct execution.

The current product contract is split by subject across `docs/`:

- [docs/architecture.md](docs/architecture.md) describes the managed application
  and execution boundary.
- [docs/configuration.md](docs/configuration.md),
  [docs/models.md](docs/models.md), and
  [docs/managed-service.md](docs/managed-service.md) define the administrative
  inputs and effective policy.
- [docs/security.md](docs/security.md) defines the trust model, guarantees, and
  residual risks.
- [docs/installation.md](docs/installation.md) defines packaging and operational
  behavior.
- [docs/testing.md](docs/testing.md) defines required verification.

Treat these as the maintained current-state documents. When behavior changes,
update the applicable subject document instead of creating a separate general
design summary.

The authoritative contract for integrating and upgrading the pinned Pi source
is [specs/pi-integration.md](specs/pi-integration.md). Treat that behavioral
contract as authoritative when an upstream upgrade requires patches to be
reimplemented rather than mechanically reapplied.

## End-state invariants

- Support Linux x86-64/arm64 with `bubblewrap` or `direct` execution and macOS
  x86-64/arm64 with `direct` or `seatbelt` execution. Qualify each macOS architecture separately. Never silently substitute one
  backend for another. The build-selected Linux distribution must choose either
  an absolute system Bubblewrap executable or a verified bundled executable;
  runtime configuration cannot change that provider.
- Optional macOS native tools are selected only by the build distribution's pinned `tool_bundle` inventory. Keep system selection as the default. Runtime configuration cannot replace that bundle or fixed typed-tool selection; selected missing commands fail closed. Main-only `execution.command_path_prepend` adds trusted command directories after bundled tools and before the backend PATH, using the same canonical snapshot for execution and Bash analysis. Reject invalid/missing directories and writable-CWD or private/hidden/denied placement. Keep raw sandbox PATH reserved. Validate the full native dependency closure and preserve bundled licenses, provenance, hashes, and executable modes. Managed paths follow the real executable; standalone paths follow the extracted package. Confined backends must reject writable-workspace overlap and exclusions that hide selected prerequisites. Bundles are trusted installation code, not a new sandbox backend.
- Preserve host absolute paths inside the sandbox.
- In Bubblewrap mode, present the ordinary host filesystem read-only except main-policy `filesystem.hidden_paths`, which masks canonical existing directories with private read-only filesystems and regular files with private empty read-only data. Silently skip missing targets at worker startup while rejecting symlink components and other invalid targets; skipped paths created later on the host may remain visible until restart. Restore only the launch CWD through hidden ancestors at its identical path, read/write or read-only according to `filesystem.cwd_writable`, then honor explicit hidden descendants. User/group overrides cannot erase masks. Preserve private writable runtime/temp locations; reject hidden paths in direct mode and read-only CWD access with direct execution or CWD exactly `/tmp`.
- Default Bubblewrap networking to `none`, denying connectable sockets. Permit
  `local` TCP/UDP on private loopback only, with no external routes or host Unix
  sockets. Restrict anonymous socket pairs to connected Unix stream pairs in
  both isolated modes. Explicit `host` shares unrestricted host networking.
  Require `host` whenever `direct` is selected.
- On macOS, Seatbelt uses fixed `/usr/bin/sandbox-exec` with ordinary host paths, read-only host access except writable CWD and real host scratch directories, and base-policy `filesystem.denied_paths` for canonical existing file/directory denials, skipping missing targets at startup while rejecting symlink components, non-directory ancestors, special files and permission errors. Skipped paths created later may be visible until restart. Denied entries are not empty masks. Reject `hidden_paths`, `network.mode = "local"`, in Seatbelt mode; other backends reject denied paths. No private `/tmp` or PID/network/mount namespaces are claimed. Concurrent command execution uses best-effort process-group cleanup only. Background descendants may survive ordinary completion, cancellation, close, or owner death with their original grants; cleanup attempts signal only a still-active direct child's process group. Add no watcher, guardian, observer, Python helper, or new service. macOS may use HTTPS administration/audit; install no privileged daemon there.
- Build one precompiled Bun `pi-sandbox` application from pinned Pi source and the separately maintained Pi Sandbox extension. Force that extension through Pi's inline factory API, disable Pi's built-in extension factories, and permit no user/project extensions or package-management commands. Package the concurrent Linux Rust configuration/audit daemon separately; it is never a wrapper, per-user systemd process or execution backend.
- Keep reusable tools and execution backends in `packages/sandbox-extension`,
  reusable Git clone in `packages/git-extension`, and the generic SDK subagent
  runner in `packages/subagents-extension`. Keep managed child composition in
  `src/subagents` and one root approval/grant scope across all children. Main-only
  subagent enablement, concurrent capacity and persistent new-spawn quotas
  cannot be broadened by project configuration or child lifecycle changes. One
  `tools.subagents` policy governs all five management operations; preserve actual
  operation names for display and audit. Keep permissions and approval
  UI internal to the managed application in `src/permissions`; standard entries
  provide no managed approvals. Preserve the application-owned managed/`pi-tool`
  composition and mandatory authorization/audit adapters.
  The managed product composes those modules with its mandatory administration,
  MCP and audit controls. The ordinary Pi artifact must load without managed Pi
  patches, private repository dependencies or a sibling checkout. Qualify both
  consumers when changing shared code; never let a standalone convenience bypass
  the managed authorization boundary. The public executor interface must remain
  backend-neutral; managed backend selection and auditing belong to the application.
- Distribution schema 4 fixes a per-platform configuration union: service with one immutable endpoint, or local with `config_dir`, Boolean `allow_config_override` and optional `audit_endpoint`. Reject obsolete fields and source switching. Service builds obtain policy/overrides/environment/models through authenticated bootstrap without local/cache fallback. Local builds read schema-16 TOML and its absolute `models_file` as the invoking user; only a compiled true override capability admits leading `--config`. Local profiles have no account rules. Both normalize to the same immutable source/resolved snapshot, validate all modes, select once and reuse it across sessions, refresh and children. Mode listing reads policy only, never catalogs/secrets. Disabled local audit performs no network/identity lookup; enabled local audit requires its fixed endpoint.
- Keep model catalogs in memory with built-ins, user model files, persistent caches and downloaded catalogs disabled. Model authentication uses only the captured expanded Pi environment, with no ambient key/header/routing repair or command expressions. Reject CLI/SDK/runtime auth overrides. Main `model_auth.personal_providers` defaults empty and admits only configured providers. Personal records are bounded raw literal data with atomic locked writes; present personal credentials win, invalid/failed credentials never fall back. Preserve native API-key/OAuth/cloud methods through explicit selected sources while rejecting command sources, default chains and administrative routing/header conflicts. Native auth CLI and UI paths must share admission, including read-only credential checks/printing. Preserve provider/model-local missing-header availability.

- Require a main-defined workspace mode on operational launch: optional `--workspace-mode` follows the optional leading `--config`; otherwise use the effective required default. Bound main source to 1 MiB and validate every authored entry/composed mode, including disallowed definitions, before account resolution. Run platform guards before account resolution, during installation/backend validation and after overrides. Only CWD writability, exports and complete Bash/write/edit invocation policies may overlay partial common defaults; optional bounded descriptions are display-only. Service account rules may override allowed/default: union explicit lists, reject conflicting defaults, preserve empty versus omitted, and validate effective default membership even with an explicit choice. Select the composed mode before applying remaining account policy once. Keep mode/policy fixed across session/executor recreation and children; a new process resolves current policy. `--list-workspace-modes` lists only permitted names/descriptions/default with ordinary root guards and authenticated source-only inspection, with no model/session/MCP/executor or secret-file startup. Main-only exhaustive `audit.tools` covers every configured subject; reject obsolete inline audit fields and keep MCP audit separate. Require service protocol 1/record 7 and explicit migration; no compatibility aliases or implicit presets.
- Main-only optional `skills.directories` adds filterable shared discovery roots for every user. Preserve personal skill name precedence, native `--no-skills` and explicit `--skill` behavior. Validate roots as the invoking user before interface startup; retain roots through identity merging and runtime recreation. Optional distribution `skills_source` requires explicit installed-root policy, complete asset/mode inventory, and pre-swap candidate validation against retained configuration. Keep account-rule skill overrides rejected.
- Preserve `PI_CODING_AGENT_DIR` for user state such as credentials, sessions, settings, skills, themes, and logs. It must not redirect administrative configuration or the model catalog.
- Expand bare `~`, leading `~/`, and `{{username}}`/`{{uid}}` in configured hidden and denied paths, scoped environment string values, and explicit MCP stdio environment values. On macOS, denied paths and those environment fields support `{{machine_id}}`, resolved lazily from the host hardware UUID through fixed bounded `ioreg` with a cleared environment, independently of account identity and at most once per startup. Hidden paths are Linux Bubblewrap-only and cannot resolve this macOS-only macro. Resolve the invoking effective OS account once after account merging; ignore ambient identity variables and CWD. Unavailable requested hardware identity fails effective policy startup; an MCP-stdio-only lookup failure disables that server. No hardware query during offline installation validation; live service validation runs as its chosen unprivileged account. Hardware UUIDs are copyable identifiers, not secrets or device attestation. MCP URLs remain literal, including query parameters. Revalidate expanded inputs, reject unknown macro syntax, preserve literal installation/config/model/executable paths, and never expand against the installer account during validation.
- Accept strict `{ file = "/absolute/path" }` only in authored `environment.pi`. Local references read as the invoking user; service bootstrap reads effective main/rule references after joining declarations. Use ordinary permissions and symlinks, bounded regular UTF-8 reads, one trailing LF/CRLF removal, nonempty values and environment bounds. Return file-derived values as wire-only `{literal}` wrappers; never accept file instructions on the wire or literal wrappers in TOML. Require main schema 16, service rules 12 and service protocol 1. Keep contents opaque to macros; sanitize errors. Offline validation never resolves/copies secret files; live service validation does resolve an actual bootstrap. Deployment protects privileged read targets from untrusted redirection.
- One concurrent Linux service binds Unix/HTTPS listeners with bounded resources and per-audit-handle sequencing. Any Unix listener requires root; HTTPS-only may run unprivileged. Administrative files and rule directories belong to the effective service UID, with root-or-service-owned non-symlink ancestors protected from group/other writes; secrets and rules remain 0600. Apply identical admission/ownership in startup and offline validation, rejecting non-root mixed listeners before activation. Keep client Unix socket/root ancestry checks unchanged. Unix identity is kernel UID/PID plus host account lookup; HTTPS Basic credentials authenticate a client population that asserts usernames. HTTPS accepts exact username rules only, never server-NSS/group equivalence. Document bundled credential extraction/impersonation and no attestation. Compile client endpoint/password/trust; public bundled CAs by default, optional replacement CA bundle, no runtime proxy/CA/insecure override or redirect. Listener-owned audit facility and policy origin remain explicit.
- Audit intent must be accepted before audited tool/export effects. Fail the current attempt on audit outage, then permit a later explicit user-input/export checkpoint to check/reopen state without replay or policy refresh. Keep input hooks in external TUI/print/RPC adapters after session start; exclude commands, internal continuations, queued draining and managed children. Restore rejected TUI input/attachments. Fence session changes, in-flight invalidation and export publication bindings. Syslog acceptance is not durable storage or independent execution proof.

- Keep user-only `/sandbox save` and its interactive exit prompt main-policy gated by `[exports].enabled` and a confined backend, with either writable or read-only CWD. Check private scratch under sandbox authority and prompt before TUI and sandbox teardown only when regular files exist or the bounded check cannot complete; Escape or cancelled/failed saving keeps the session open; Ctrl+C on the exit confirmation exits without saving. Signals bypass or abort the prompt. Read sources under sandbox authority, keep export capabilities separate from model tools, and require user-reviewed mappings, explicit replacement approval and pre-effect audit. Host publication may target writable CWD but must reject private scratch overlap. Preserve fresh-inode/no-truncate, atomic no-replace and observed path/identity checks as best-effort concurrent protection. Accept hostile background destination, staging and replacement races under the host user's authority, analogous to host Git cloning; foreground idle is not complete process ownership, and hashes describe copied bytes rather than durable destination integrity. Add no process monitor or confined writer. No automatic scratch retention.
- Require main-policy `[sessions].retention_days` (0 disables; packaged default 365). Use session-file modification time and refresh it on startup/resume when enabled. Await best-effort shallow cleanup before interface startup, normally once per 24 hours; only slow interactive sweeps display progress. Keep scheduling state under the agent directory, tolerate concurrent sweeps and cleanup errors, and leave audit-log retention to the host.
- Provide managed replacements for `read`, `grep`, `find`, `ls`, `write`, `edit`,
  and `bash`, and route user `!` shell commands through the selected execution
  backend. Exclude all stock built-in tool definitions from managed sessions,
  including Pi 1.5.0's unsupported `powershell`. Tool selections, registry
  refreshes, and session recreation must not restore them. Review every upstream
  tool addition explicitly before admitting a managed implementation.
- Never fall back to direct execution after a Bubblewrap, Seatbelt, approval,
  cancellation, or lifecycle failure.
- Permit administrator-configured host HTTP/stdio MCP through the managed adapter, with original-tool wildcard policies, typed catalog revisions and the shared approval engine. Code mode is an administrator-permitted QuickJS feature with ordinary Pi activation settings; all nested tools retain ordinary policy and execution boundaries. The MCP menu may persist enabled/exposure preferences for admitted servers only. Never accept user/project MCP connection definitions or general extension factories.
- Service rules may override `mcp.servers.<id>.enabled`, `default_policy` and ordered `tool_rules` for main-defined servers. Explicit true wins independently of invocation policy; resolve first match/default per file then join complete pairs. Preserve main audit and per-file ordered layers, deduplicating only whole layers. Validate every rule structurally and only matching tool/MCP/mode inventory against the listener policy. Connection definitions, credentials, exposure, timeouts and code-mode admission stay main-only. Recheck exposure after merging; disabled servers skip startup and personal preferences cannot enable them. Enforce aggregate/serialized bounds before writing.

- Keep `build:release` a build/package/integrity workflow without behavioral suites or test skip flags. `verify:release` must retain all source/API negative controls, upstream/theme suites, native/package/install checks and packaged-runtime smoke through both builder verification checkpoints. Exercise local and service source artifacts plus Unix/HTTPS audit transport with offline fixtures, without changing production inputs. Preserve truthful clean/dev/dirty version stamping.
- User optional-extension preferences may only narrow administrator admission. Keep mandatory sandbox and approvals untoggleable; main-only conditional guidance follows active extension tools.
- Keep tool availability separate from invocation approval. Support strict `allow`, `ask`, `deny`, and `disabled` modes.
- Configure whether `Allow for session` is offered independently for every
  model-tool approval subject. Session grants are memory-only, narrowly
  scoped, and never persisted. User `!` shell is fixed-allow without a prompt
  and uses the selected execution backend.
- Treat configuration as strict and versioned. Reject unknown fields and missing effective tool policy in any composed mode. Project-local content must not broaden system/user policy.
- Preserve Pi scheduling across backends: remove extra serial admission and fixed active/outstanding request ceilings, but retain same-file mutation coordination, approvals and bounded transport/input/output. Commands complete independently; background descendants may survive. Request-local cancellation, timeout, overflow and spawn/callback failures must not sweep peers. Linux final shutdown retains its namespace boundary; fatal worker/transport failure may abort the executor. No watcher, guardian, helper or descendant monitoring.
- Commands have no implicit timeout. Optional managed base `execution.max_command_timeout_seconds`, standalone common `maximumTimeoutMs` and executor `limits.maximumTimeoutMs` cap each command from successful launch through drain, excluding admission/approval/coordination waits. Reject over-cap requests and obsolete lifetime/default-timeout fields. Preserve positive finite fractional caller seconds through JavaScript's timer ceiling. Keep host Git/MCP/Code Mode timing separate.
- Preserve Pi's 100 ms post-exit idle drain reset by output, without an absolute drain deadline. Once the direct child exits never signal its former PID/process group; cancellation and close detach streams. Mac survivors retain their original grants. Keep the accepted host Git destination race; add no clone-specific termination or publication helper.
- Main-only optional `extensions.git.destination` selects `host_cwd` (default,
  independent of CWD writability) or Linux Bubblewrap `sandbox_home`. Keep
  repository-only arguments, original locator admission, approvals and exact
  audit targets. Scratch cloning uses private verified host tmpfs acquisition
  and bounded descriptor-based worker import, never a host-write or disk-staging
  fallback. Preserve standalone host-only config, reject unsupported effective
  backends, and keep partial-checkout removal explicit. Bundle limits are not
  hard acquisition or total-memory quotas; retain existing same-user mutation
  and abrupt-exit cleanup limitations. No new helper or publication process.

## Development

- Keep `CHANGELOG.md` Unreleased entries concise and add PR links once their numbers are known.
- Prefer end-state contracts without compatibility aliases or fallback parsers.
- Keep Pi-specific changes as a minimal documented patch series against the exact source release pinned in `pi-source.lock.json`; never commit an extracted Pi worktree.
- Keep all tests offline. Do not invoke live LLM providers.
- Use Node.js 24 or newer, Bun 1.4.4 or newer for compiled application builds, and Rust/Cargo 1.85 or newer; keep `NODE_ENV` unset for installs, builds, and tests. Older Bun TLS implementations unioned host/default roots into an explicit CA list and cannot satisfy the service trust contract.
- Verify formatting/linting, type checking, unit tests, integration tests, real Bubblewrap tests, build output, and package/install smoke tests before release.

- Main-authored common or mode `tools.bash.command_sets` defines narrow administrator allow assertions,
  not product-certified read-only commands. Preserve per-stage whole-call policy
  composition, disabled-tool precedence, immutable evidence and main definitions
  across account overrides. Audit configured decisions with service protocol 1 and
  record schema 7; neither account rules nor wire patches may redefine the grammar. Require the same normalized command-set definition for any ID reused across all common/mode entries, including unused entries. Records do not identify workspace modes or policy revisions.
