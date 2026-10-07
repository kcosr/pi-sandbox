# Changelog

## Unreleased

- Support individual file exclusions alongside directory masks. ([#10](https://github.com/kcosr/pi-sandbox/pull/10))
- Clean up old saved sessions before startup, using configurable retention and last-use timestamps. ([#10](https://github.com/kcosr/pi-sandbox/pull/10))
- Require config schema 8 with `[sessions].retention_days` (`365` by default; `0` disables cleanup). ([#10](https://github.com/kcosr/pi-sandbox/pull/10))
