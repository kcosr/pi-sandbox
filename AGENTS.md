# Repository agent guide

This project provides a policy-gated execution boundary in a managed Pi
distribution. Linux supports Bubblewrap and explicit direct execution; macOS
supports direct execution only.

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
  x86-64/arm64 with `direct` execution only. Never silently substitute one
  backend for another. The build-selected Linux distribution must choose either
  an absolute system Bubblewrap executable or a verified bundled executable;
  runtime configuration cannot change that provider.
- Preserve host absolute paths inside the sandbox.
- Present the ordinary host filesystem read-only and explicitly bind the launch CWD at the identical path, read/write or read-only according to `filesystem.cwd_writable`. Preserve private writable runtime/temp locations; reject read-only CWD access with direct execution or CWD exactly `/tmp`.
- Default Bubblewrap tool and shell networking to an isolated namespace with
  socket creation denied. Permit only the explicit administrator-selected
  `host` mode, which shares the complete host network namespace; provide no
  filtered-network mode or fallback. Require `host` whenever `direct` is
  selected.
- Build one precompiled Bun `pi-sandbox` application from pinned Pi source and the separately maintained Pi Sandbox extension. Force that extension through Pi's inline factory API, disable Pi's built-in extension factories, and permit no user/project extensions or package-management commands. Package the optional user/group resolver as a separate static Rust broker; it is never a wrapper or sandbox backend.
- Read base policy and global scoped environment through the build-selected `config_dir/config.toml` entry point, or an explicit leading `--config FILE` only when the distribution was built with `allow_config_override = true`. Managed distributions must compile that switch as false and reject the flag. Require its administrator-selected `models_file`, disable Pi's internal model catalog, and fail closed when any effective input is invalid. Optional broker mode resolves kernel-authenticated accounts and primary/supplementary membership through the host account service. Root-managed `config_dir/users.d/*.toml` and `config_dir/groups.d/*.toml` rules select names or numeric IDs. Combine matching explicit permissions using least restrictive wins before overlaying defaults; reject conflicting backend, model, or scoped environment values. Return one environment and model, execution, network, filesystem, and complete named-tool invocation-policy patch. Logging remains parent-only. No matching rules means the main configuration is inherited unchanged. Scoped environment never selects or enables tools.
- Preserve `PI_CODING_AGENT_DIR` for user state such as credentials, sessions, settings, skills, themes, and logs. It must not redirect administrative configuration or the model catalog.
- Replace all seven Pi built-ins (`read`, `grep`, `find`, `ls`, `write`, `edit`,
  and `bash`) and route user `!` shell commands through the selected execution
  backend.
- Never fall back to direct execution after a Bubblewrap, approval,
  cancellation, or lifecycle failure.
- Keep tool availability separate from invocation approval. Support strict `allow`, `ask`, `deny`, and `disabled` modes.
- Configure whether `Allow for session` is offered independently for every
  model-tool approval subject. Session grants are memory-only, narrowly
  scoped, and never persisted. User `!` shell is fixed-allow without a prompt
  and uses the selected execution backend.
- Treat configuration as strict and versioned. Reject unknown fields and missing tool policy. Project-local content must not broaden system/user policy.
- In Bubblewrap mode, start one worker for the `pi-sandbox` process and run each
  approved operation inside it. In direct mode, start each operation directly
  as the current user. In both modes use bounded direct argument vectors and
  kill command descendants after every operation and on cancellation or
  shutdown.

## Development

- Prefer end-state contracts without compatibility aliases or fallback parsers.
- Keep Pi-specific changes as a minimal documented patch series against the exact source release pinned in `pi-source.lock.json`; never commit an extracted Pi worktree.
- Keep all tests offline. Do not invoke live LLM providers.
- Use Node.js 24 or newer and Rust/Cargo 1.85 or newer; keep `NODE_ENV` unset for installs, builds, and tests.
- Verify formatting/linting, type checking, unit tests, integration tests, real Bubblewrap tests, build output, and package/install smoke tests before release.
