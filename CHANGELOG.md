# Changelog

## Unreleased

- Add managed HTTP/stdio MCP and optional code mode with nested tool permissions and tool-selection guidance; require config schema 10. ([#13](https://github.com/kcosr/pi-sandbox/pull/13))
- Support `{{username}}` and `{{uid}}` in configured paths and environment values. ([#13](https://github.com/kcosr/pi-sandbox/pull/13))
- Skip missing hidden paths at startup. ([#12](https://github.com/kcosr/pi-sandbox/pull/12))
- Expand `~` in exclusions and scoped environment values; require config schema 9. ([#11](https://github.com/kcosr/pi-sandbox/pull/11))
- Support individual file exclusions alongside directory masks. ([#10](https://github.com/kcosr/pi-sandbox/pull/10))
- Clean up old saved sessions before startup, using configurable retention and last-use timestamps. ([#10](https://github.com/kcosr/pi-sandbox/pull/10))
- Require `[sessions].retention_days` (`365` by default; `0` disables cleanup). ([#10](https://github.com/kcosr/pi-sandbox/pull/10))
