# Changelog

## Unreleased

### Changed

- Clarify cross-platform execution diagrams, backend guarantees, diagnostics and installation guidance for Bubblewrap, Seatbelt and direct execution. ([#38](https://github.com/kcosr/pi-sandbox/pull/38))

## 0.8.0 - 2026-10-16

### Breaking changes

- Update managed configurations to version 13 and standalone sandbox configurations to version 6; remove obsolete process-lifetime settings. ([#30](https://github.com/kcosr/pi-sandbox/pull/30))
- Reject `BASHOPTS`, `CDPATH`, `GLOBIGNORE` and `IFS` in `environment.sandbox` and the Bubblewrap executor environment, matching Seatbelt. ([#34](https://github.com/kcosr/pi-sandbox/pull/34))
- Require explicit `filesystem.denied_paths` in managed policy and strict standalone Seatbelt configuration. ([#29](https://github.com/kcosr/pi-sandbox/pull/29))
- Remove smolvm execution, VM controllers and interactive VM terminals; managed Linux execution supports Bubblewrap or direct mode. ([#28](https://github.com/kcosr/pi-sandbox/pull/28))
- Release reusable sandbox extension 0.8.0 with a backend-neutral executor interface and no VM/controller exports. Embedding applications own external execution and cleanup. ([#28](https://github.com/kcosr/pi-sandbox/pull/28))

### Added

- Explain tool and user home directories in managed Bubblewrap and Seatbelt system-prompt context without changing execution environments or filesystem permissions. ([#35](https://github.com/kcosr/pi-sandbox/pull/35))
- Add an optional `[tools.bash.known_read_only]` policy, including broker rules and audit fields, so recognized read-only model Bash commands can use a more permissive approval policy than other Bash commands. Classification never changes execution. ([#34](https://github.com/kcosr/pi-sandbox/pull/34))
- Support macOS `{{machine_id}}` in administrator environment values and Seatbelt denied paths, including provider API keys through configured Pi environment variables. Resolve the hardware UUID only when requested; no authentication or device-attestation guarantee is implied. ([#32](https://github.com/kcosr/pi-sandbox/pull/32))
- Default macOS packages to Seatbelt execution with networking disabled, directory denials and read-only CWD support. Process cleanup is best effort; background survivors retain their original grants. ([#29](https://github.com/kcosr/pi-sandbox/pull/29))
- Add build-selected macOS tool bundles with pinned native inventories, packaged licenses, relocatable paths and no runtime tool-directory override. ([#29](https://github.com/kcosr/pi-sandbox/pull/29))
- Support `bearer_token_from_env` for HTTP MCP credentials, adding the Bearer prefix to a raw environment token. ([#31](https://github.com/kcosr/pi-sandbox/pull/31))

### Changed

- Upgrade managed and standalone Pi integration to 1.3.0, preserving sandbox policies, disabled sharing and configured-only model catalogs. ([#36](https://github.com/kcosr/pi-sandbox/pull/36))

- Upgrade managed and standalone Pi integration to 1.2.0, preserving configured-only models, MCP approvals and bounded Code Mode execution. ([#33](https://github.com/kcosr/pi-sandbox/pull/33))
- Follow Pi's parallel scheduling across backends, isolate command cancellation from peers, and replace implicit timeouts with an optional administrator maximum. ([#30](https://github.com/kcosr/pi-sandbox/pull/30))

### Fixed

- Format numeric-string and null read ranges using Pi's renderer while preserving full paths and tool-home labels. ([#36](https://github.com/kcosr/pi-sandbox/pull/36))

- Preserve full paths in sandbox tool cards and label explicit `~` paths as tool-home paths instead of abbreviating them against Pi's host home. ([#35](https://github.com/kcosr/pi-sandbox/pull/35))
- Exclude stock Pi tool implementations from managed sessions so tool selection and MCP catalog refresh cannot restore policy-disabled tools. ([#33](https://github.com/kcosr/pi-sandbox/pull/33))

## 0.7.0 - 2026-10-10

### Breaking changes

- Require standalone sandbox configuration version 4 without tool policies; approvals remain managed-only. ([#21](https://github.com/kcosr/pi-sandbox/pull/21))

### Added

- Add host-controlled interactive OCI terminals with scoped client cleanup and clean retention of edited originals. ([#22](https://github.com/kcosr/pi-sandbox/pull/22))
- Add standalone Git cloning and independently installable sandbox tools while preserving managed approvals and audit. ([#21](https://github.com/kcosr/pi-sandbox/pull/21))
- Run smolvm tools concurrently with bounded admission, coordinated VM cleanup and Pi-compatible output draining. ([#20](https://github.com/kcosr/pi-sandbox/pull/20))
- Run Bubblewrap tools concurrently with sandbox process lifetime, preserving coordinated cancellation and cleanup. ([#19](https://github.com/kcosr/pi-sandbox/pull/19))

### Changed

- Clarify source-only installation, backend selection, and reusable extension documentation. ([#23](https://github.com/kcosr/pi-sandbox/pull/23))
- Add an explicit required Linux smolvm release lane covering managed, standalone, OCI, and interactive terminal checks. ([#23](https://github.com/kcosr/pi-sandbox/pull/23))

### Fixed

- Update four development dependency resolutions to address denial-of-service advisories in lint/test tooling. ([#23](https://github.com/kcosr/pi-sandbox/pull/23))
- Retire OCI families when terminal opening detects a lost VM identity, and report each terminal cleanup failure once. ([#22](https://github.com/kcosr/pi-sandbox/pull/22))

## 0.6.0 - 2026-10-10

### Breaking changes

- Require managed configuration schema 11. Update older configurations to the current packaged examples; the schema 9 and 10 changes introduced during development are included in schema 11. ([#11](https://github.com/kcosr/pi-sandbox/pull/11), [#13](https://github.com/kcosr/pi-sandbox/pull/13), [#17](https://github.com/kcosr/pi-sandbox/pull/17))
- Require `[sessions].retention_days` (`365` in packaged defaults; `0` disables cleanup). ([#10](https://github.com/kcosr/pi-sandbox/pull/10))

### Added

- Add independent product release versioning, a combined Pi/Pi Sandbox CLI and TUI version display, and a documented source-only release process. ([#18](https://github.com/kcosr/pi-sandbox/pull/18))
- Add Linux smolvm 1.25.4 execution to managed and ordinary Pi, with reusable OCI branching/attachments and documented manual crash recovery. ([#17](https://github.com/kcosr/pi-sandbox/pull/17))
- Add Bubblewrap-local networking and configurable background-process lifetime. ([#15](https://github.com/kcosr/pi-sandbox/pull/15))
- Add managed HTTP/stdio MCP and optional code mode with nested tool permissions and tool-selection guidance. ([#13](https://github.com/kcosr/pi-sandbox/pull/13))
- Support `{{username}}` and `{{uid}}` in configured paths and environment values. ([#13](https://github.com/kcosr/pi-sandbox/pull/13))
- Expand `~` in exclusions and scoped environment values. ([#11](https://github.com/kcosr/pi-sandbox/pull/11))
- Support individual file exclusions alongside directory masks. ([#10](https://github.com/kcosr/pi-sandbox/pull/10))
- Clean up old saved sessions before startup, using configurable retention and last-use timestamps. ([#10](https://github.com/kcosr/pi-sandbox/pull/10))

### Changed

- Extract reusable sandbox tools, permissions and execution into a standard Pi extension package, shared with the managed build. ([#16](https://github.com/kcosr/pi-sandbox/pull/16))
- Upgrade Pi to 1.1.0; support additive tool selection within TOML policy and disable project `.env` autoload. ([#14](https://github.com/kcosr/pi-sandbox/pull/14))
- Skip missing hidden paths at startup. ([#12](https://github.com/kcosr/pi-sandbox/pull/12))

### Fixed

- Close a Unix datagram socket-pair bypass in isolated Bubblewrap networking. ([#15](https://github.com/kcosr/pi-sandbox/pull/15))
- Report failed write/edit replacements and clean up temporary files. ([#13](https://github.com/kcosr/pi-sandbox/pull/13))
