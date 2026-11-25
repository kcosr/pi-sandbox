#!/bin/sh
set -eu
expected_arch=x64
[ "$#" -eq 0 ] || { echo "usage: install.sh" >&2; exit 2; }
destdir=${DESTDIR:-}
case "$destdir" in ""|/) destdir= ;; /*) while [ "${destdir%/}" != "$destdir" ]; do destdir=${destdir%/}; done ;; *) echo "DESTDIR must be absolute" >&2; exit 2 ;; esac
if [ -z "$destdir" ]; then
  [ "$(id -u)" -eq 0 ] && [ "$(uname -s)" = Linux ] || { echo "live service installation requires root on Linux" >&2; exit 1; }
fi
case "$(uname -m)" in x86_64) host_arch=x64 ;; aarch64|arm64) host_arch=arm64 ;; *) host_arch=unsupported ;; esac
[ "$(uname -s)" = Linux ] && [ "$host_arch" = "$expected_arch" ] || { echo "service package platform/architecture mismatch" >&2; exit 1; }
release_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
payload="$release_root/payload/pi-sandbox-service"
[ -d "$payload" ] && [ ! -L "$payload" ] && [ -f "$release_root/SHA256SUMS" ] && [ ! -L "$release_root/SHA256SUMS" ] || { echo "invalid service release" >&2; exit 1; }
[ -z "$(find "$payload" ! -type d ! -type f -print -quit)" ] || { echo "unsupported payload entry" >&2; exit 1; }
awk 'NF != 2 || $0 != $1 "  " $2 || $1 !~ /^[0-9a-f]{64}$/ || $2 !~ /^payload\/pi-sandbox-service\// || $2 ~ /(^|\/)\.\.?($|\/)/ || $2 ~ /\/\// || $2 ~ /\/$/ || ++seen[$2] != 1 { exit 1 }' "$release_root/SHA256SUMS" || { echo "invalid checksum inventory" >&2; exit 1; }
[ "$(find "$payload" -type f | wc -l)" -eq "$(wc -l < "$release_root/SHA256SUMS")" ] || { echo "incomplete checksum inventory" >&2; exit 1; }
(cd "$release_root" && sha256sum -c SHA256SUMS >/dev/null)
for path in pi-sandbox-service pi-sandbox-service.service sbom.cdx.json release-manifest.json examples/service.toml; do
  [ -f "$payload/$path" ] || { echo "incomplete service payload" >&2; exit 1; }
done
[ -x "$payload/pi-sandbox-service" ] || { echo "service is not executable" >&2; exit 1; }
base="$destdir/usr/libexec/pi-sandbox-service"
unit="$destdir/usr/lib/systemd/system/pi-sandbox-service.service"
examples="$destdir/usr/share/pi-sandbox-service/examples"
for parent in "${base%/*}" "${unit%/*}" "${examples%/*}"; do
  [ ! -L "$parent" ] || { echo "symlink installation parent" >&2; exit 1; }
  mkdir -p "$parent"; chmod 0755 "$parent"
done
for path in "$base" "$examples"; do [ ! -e "$path" ] && [ ! -L "$path" ] || { [ -d "$path" ] && [ ! -L "$path" ]; } || { echo "invalid existing installation" >&2; exit 1; }; done
[ ! -e "$unit" ] && [ ! -L "$unit" ] || { [ -f "$unit" ] && [ ! -L "$unit" ]; } || { echo "invalid existing unit" >&2; exit 1; }
lock="${base%/*}/.pi-sandbox-service.install.lock"
mkdir "$lock" || { echo "another service installation is active" >&2; exit 1; }
stage=; old=; example_stage=; old_examples=; unit_stage=; old_unit=; complete=0; new_base=0; new_examples=0; new_unit=0
cleanup() {
  status=$?; set +e
  if [ "$complete" -eq 0 ]; then
    [ "$new_base" -eq 0 ] || rm -rf "$base"; [ -z "$old" ] || mv "$old" "$base"
    [ "$new_examples" -eq 0 ] || rm -rf "$examples"; [ -z "$old_examples" ] || mv "$old_examples" "$examples"
    [ "$new_unit" -eq 0 ] || rm -f "$unit"; [ -z "$old_unit" ] || mv "$old_unit" "$unit"
  fi
  for path in "$stage" "$old" "$example_stage" "$old_examples" "$unit_stage" "$old_unit"; do [ -z "$path" ] || rm -rf "$path"; done
  rmdir "$lock"; exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM
stage=$(mktemp -d "${base%/*}/.pi-sandbox-service.stage.XXXXXX")
cp -R "$payload/." "$stage/"
find "$stage" -type d -exec chmod 0755 {} +
find "$stage" -type f -exec chmod 0644 {} +
chmod 0755 "$stage/pi-sandbox-service"
example_stage=$(mktemp -d "${examples%/*}/.examples.stage.XXXXXX")
cp -R "$stage/examples/." "$example_stage/"; chmod 0755 "$example_stage"
unit_stage=$(mktemp "${unit%/*}/.pi-sandbox-service.unit.XXXXXX")
install -m 0644 "$stage/pi-sandbox-service.service" "$unit_stage"
if [ -e "$base" ]; then old="${stage}.previous"; mv "$base" "$old"; fi
new_base=1; mv "$stage" "$base"; stage=
if [ -e "$examples" ]; then old_examples="${example_stage}.previous"; mv "$examples" "$old_examples"; fi
new_examples=1; mv "$example_stage" "$examples"; example_stage=
if [ -e "$unit" ]; then old_unit="${unit_stage}.previous"; mv "$unit" "$old_unit"; fi
new_unit=1; mv "$unit_stage" "$unit"; unit_stage=
complete=1
printf '%s\n' "installed $base/pi-sandbox-service" "installed $unit" "installed $examples" "Deployment owns /etc/pi-sandbox-service, credentials and service activation."
