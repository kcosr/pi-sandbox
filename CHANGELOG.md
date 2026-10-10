# Changelog

## Unreleased

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
