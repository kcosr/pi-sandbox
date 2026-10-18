# Repository agent guide

This project provides a policy-gated execution boundary in a managed Pi
distribution. Linux supports Bubblewrap and explicit direct execution;
macOS packages select Seatbelt execution by default and support explicit direct execution.

The current product contract is split by subject across `docs/`:

- [docs/architecture.md](docs/architecture.md) describes the managed application
  and execution boundary.
- [docs/configuration.md](docs/configuration.md),
  [docs/models.md](docs/models.md), and
  [docs/identity-broker.md](docs/identity-broker.md) define the administrative
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
- Optional macOS native tools are selected only by the build distribution's pinned `tool_bundle` inventory. Keep system selection as the default. Admit no runtime configuration or environment override for tool directories; selected missing commands fail closed. Validate the full native dependency closure and preserve bundled licenses, provenance, hashes, and executable modes. Managed paths follow the real executable; standalone paths follow the extracted package. Confined backends must reject writable-workspace overlap and exclusions that hide selected prerequisites. Bundles are trusted installation code, not a new sandbox backend.
- Preserve host absolute paths inside the sandbox.
- In Bubblewrap mode, present the ordinary host filesystem read-only except main-policy `filesystem.hidden_paths`, which masks canonical existing directories with private read-only filesystems and regular files with private empty read-only data. Silently skip missing targets at worker startup while rejecting symlink components and other invalid targets; skipped paths created later on the host may remain visible until restart. Restore only the launch CWD through hidden ancestors at its identical path, read/write or read-only according to `filesystem.cwd_writable`, then honor explicit hidden descendants. User/group overrides cannot erase masks. Preserve private writable runtime/temp locations; reject hidden paths in direct mode and read-only CWD access with direct execution or CWD exactly `/tmp`.
- Default Bubblewrap networking to `none`, denying connectable sockets. Permit
  `local` TCP/UDP on private loopback only, with no external routes or host Unix
  sockets. Restrict anonymous socket pairs to connected Unix stream pairs in
  both isolated modes. Explicit `host` shares unrestricted host networking.
  Require `host` whenever `direct` is selected.
- On macOS, Seatbelt uses fixed `/usr/bin/sandbox-exec` with ordinary host paths, read-only host access except writable CWD and real host scratch directories, and base-policy `filesystem.denied_paths` for canonical existing directory denials. Denied entries are not empty masks. Reject `hidden_paths`, `network.mode = "local"`, in Seatbelt mode; other backends reject denied paths. No private `/tmp` or PID/network/mount namespaces are claimed. Concurrent command execution uses best-effort process-group cleanup only. Background descendants may survive ordinary completion, cancellation, close, or owner death with their original grants; cleanup attempts signal only a still-active direct child's process group. Add no watcher, guardian, observer, Python helper, or new service. Keep macOS broker and audit disabled.
- Build one precompiled Bun `pi-sandbox` application from pinned Pi source and the separately maintained Pi Sandbox extension. Force that extension through Pi's inline factory API, disable Pi's built-in extension factories, and permit no user/project extensions or package-management commands. Package the optional user/group resolver as a separate static Rust broker; it is never a wrapper or sandbox backend.
- Keep reusable tools and execution backends in `packages/sandbox-extension`,
  and reusable Git clone in `packages/git-extension`. Keep permissions and approval
  UI internal to the managed application in `src/permissions`; standard entries
  provide no managed approvals. Preserve the application-owned managed/`pi-tool`
  composition and mandatory authorization/audit adapters.
  The managed product composes those modules with its mandatory administration,
  MCP and audit controls. The ordinary Pi artifact must load without managed Pi
  patches, private repository dependencies or a sibling checkout. Qualify both
  consumers when changing shared code; never let a standalone convenience bypass
  the managed authorization boundary. The public executor interface must remain
  backend-neutral; managed backend selection and auditing belong to the application.
- Read base policy and global scoped environment through the build-selected `config_dir/config.toml` entry point, or an explicit leading `--config FILE` only when the distribution was built with `allow_config_override = true`. Managed distributions must compile that switch as false and reject the flag. Require its administrator-selected `models_file`, disable Pi's internal model catalog, and fail closed when any effective input is invalid. Optional broker mode resolves kernel-authenticated accounts and primary/supplementary membership through the host account service. Root-managed `config_dir/users.d/*.toml` and `config_dir/groups.d/*.toml` rules select names or numeric IDs. Combine matching explicit permissions using least restrictive wins before overlaying defaults; reject conflicting backend, model, or scoped environment values. Return one environment and model, execution, network, filesystem, MCP server enablement, and complete named-tool invocation-policy patch. Logging remains parent-only. No matching rules means the main configuration is inherited unchanged. Scoped environment never selects or enables tools.
- Preserve `PI_CODING_AGENT_DIR` for user state such as credentials, sessions, settings, skills, themes, and logs. It must not redirect administrative configuration or the model catalog.
- Expand bare `~`, leading `~/`, and `{{username}}`/`{{uid}}` in configured hidden and denied paths, scoped environment values, and explicit MCP stdio environment values. On macOS, denied paths and those environment fields support `{{machine_id}}`, resolved lazily from the host hardware UUID through fixed bounded `ioreg` with a cleared environment, independently of account identity and at most once per startup. Hidden paths are Linux Bubblewrap-only and cannot resolve this macOS-only macro. Resolve the invoking effective OS account once after broker merging; ignore ambient identity variables and CWD. Unavailable requested hardware identity fails effective policy startup; an MCP-stdio-only lookup failure disables that server. No hardware query during installation validation. Hardware UUIDs are copyable identifiers, not secrets or device attestation. MCP URLs remain literal, including query parameters. Revalidate expanded inputs, reject unknown macro syntax, preserve literal installation/config/model/executable paths, and never expand against the installer account during validation.
- Require main-policy `[sessions].retention_days` (0 disables; packaged default 365). Use session-file modification time and refresh it on startup/resume when enabled. Await best-effort shallow cleanup before interface startup, normally once per 24 hours; only slow interactive sweeps display progress. Keep scheduling state under the agent directory, tolerate concurrent sweeps and cleanup errors, and leave audit-log retention to the host.
- Provide managed replacements for `read`, `grep`, `find`, `ls`, `write`, `edit`,
  and `bash`, and route user `!` shell commands through the selected execution
  backend. Exclude all stock built-in tool definitions from managed sessions,
  including Pi 1.3.0's unsupported `powershell`. Tool selections, registry
  refreshes, and session recreation must not restore them. Review every upstream
  tool addition explicitly before admitting a managed implementation.
- Never fall back to direct execution after a Bubblewrap, Seatbelt, approval,
  cancellation, or lifecycle failure.
- Permit administrator-configured host HTTP/stdio MCP through the managed adapter, with original-tool wildcard policies, typed catalog revisions and the shared approval engine. Code mode is an administrator-permitted QuickJS feature with ordinary Pi activation settings; all nested tools retain ordinary policy and execution boundaries. The MCP menu may persist enabled/exposure preferences for admitted servers only. Never accept user/project MCP connection definitions or general extension factories.
- Linux broker rules may override only `mcp.servers.<id>.enabled` for globally defined servers. Join matching explicit booleans with true winning, then replace the main-policy default; user and group rules have equal precedence. Validate every rule structurally and matching server IDs against the active main inventory. Keep connection definitions, credential mappings, exposure, timeouts, tool policies, and code-mode availability in the main policy. Recheck code-mode exposure after merging. Disabled servers perform no server-specific resolution or transport startup; independently configured scoped environment still applies. User preferences cannot enable an administratively disabled server. Use broker protocol 8 and rule version 9; main schema 13 remains unchanged.
- Keep tool availability separate from invocation approval. Support strict `allow`, `ask`, `deny`, and `disabled` modes.
- Configure whether `Allow for session` is offered independently for every
  model-tool approval subject. Session grants are memory-only, narrowly
  scoped, and never persisted. User `!` shell is fixed-allow without a prompt
  and uses the selected execution backend.
- Treat configuration as strict and versioned. Reject unknown fields and missing tool policy. Project-local content must not broaden system/user policy.
- Preserve Pi scheduling across backends: remove extra serial admission and fixed active/outstanding request ceilings, but retain same-file mutation coordination, approvals and bounded transport/input/output. Commands complete independently; background descendants may survive. Request-local cancellation, timeout, overflow and spawn/callback failures must not sweep peers. Linux final shutdown retains its namespace boundary; fatal worker/transport failure may abort the executor. No watcher, guardian, helper or descendant monitoring.
- Commands have no implicit timeout. Optional managed base `execution.max_command_timeout_seconds`, standalone common `maximumTimeoutMs` and executor `limits.maximumTimeoutMs` cap each command from successful launch through drain, excluding admission/approval/coordination waits. Reject over-cap requests and obsolete lifetime/default-timeout fields. Preserve positive finite fractional caller seconds through JavaScript's timer ceiling. Keep host Git/MCP/Code Mode timing separate.
- Preserve Pi's 100 ms post-exit idle drain reset by output, without an absolute drain deadline. Once the direct child exits never signal its former PID/process group; cancellation and close detach streams. Mac survivors retain their original grants. Keep the accepted host Git destination race; add no clone-specific termination or publication helper.

## Development

- Keep `CHANGELOG.md` Unreleased entries concise and add PR links once their numbers are known.
- Prefer end-state contracts without compatibility aliases or fallback parsers.
- Keep Pi-specific changes as a minimal documented patch series against the exact source release pinned in `pi-source.lock.json`; never commit an extracted Pi worktree.
- Keep all tests offline. Do not invoke live LLM providers.
- Use Node.js 24 or newer and Rust/Cargo 1.85 or newer; keep `NODE_ENV` unset for installs, builds, and tests.
- Verify formatting/linting, type checking, unit tests, integration tests, real Bubblewrap tests, build output, and package/install smoke tests before release.
