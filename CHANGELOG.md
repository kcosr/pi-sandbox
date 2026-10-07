# Changelog

## Unreleased

- Support individual file exclusions alongside directory masks.
- Clean up old saved sessions before startup, using configurable retention and last-use timestamps.
- Require config schema 8 with `[sessions].retention_days` (`365` by default; `0` disables cleanup).
