# Changelog

## Unreleased

- Expand `~` in hidden paths and configured scoped environment values using the invoking account's home; require config schema 9.
- Support individual file exclusions alongside directory masks. ([#10](https://github.com/kcosr/pi-sandbox/pull/10))
- Clean up old saved sessions before startup, using configurable retention and last-use timestamps. ([#10](https://github.com/kcosr/pi-sandbox/pull/10))
- Require `[sessions].retention_days` (`365` by default; `0` disables cleanup). ([#10](https://github.com/kcosr/pi-sandbox/pull/10))
