#!/bin/sh
set -eu

usage() {
  echo "usage: install.sh [--replace-config]" >&2
  exit 2
}

replace_config=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --replace-config) replace_config=1; shift ;;
    *) usage ;;
  esac
done

destdir=${DESTDIR:-}
case "$destdir" in
  ""|/) destdir= ;;
  /*) while [ "${destdir%/}" != "$destdir" ]; do destdir=${destdir%/}; done ;;
  *) echo "DESTDIR must be an absolute path" >&2; exit 2 ;;
esac
if [ -z "$destdir" ] && [ "$(id -u)" -ne 0 ]; then
  echo "system installation must run as root" >&2
  exit 1
fi
if [ -z "$destdir" ]; then
  [ "$(uname -s)" = Darwin ] || { echo "this package requires macOS" >&2; exit 1; }
fi

if [ -z "$destdir" ]; then
  case "$(uname -m)" in
    arm64) brew_prefix=/opt/homebrew ;;
    x86_64) brew_prefix=/usr/local ;;
    *) echo "unsupported macOS architecture" >&2; exit 1 ;;
  esac
  required="$brew_prefix/opt/coreutils/libexec/gnubin/cat
$brew_prefix/opt/coreutils/libexec/gnubin/chmod
$brew_prefix/opt/coreutils/libexec/gnubin/mkdir
$brew_prefix/opt/coreutils/libexec/gnubin/mv
$brew_prefix/opt/coreutils/libexec/gnubin/rm
$brew_prefix/opt/coreutils/libexec/gnubin/head
$brew_prefix/opt/coreutils/libexec/gnubin/sha256sum
$brew_prefix/opt/coreutils/libexec/gnubin/sort
$brew_prefix/opt/coreutils/libexec/gnubin/tail
$brew_prefix/opt/coreutils/libexec/gnubin/test
$brew_prefix/opt/coreutils/libexec/gnubin/wc
$brew_prefix/opt/findutils/libexec/gnubin/find
$brew_prefix/opt/grep/libexec/gnubin/grep
$brew_prefix/bin/gawk
/bin/bash
/bin/sh
/usr/bin/file"
  missing=
  for executable in $required; do
    [ -x "$executable" ] || missing="$missing $executable"
  done
  command -v fd >/dev/null 2>&1 || missing="$missing fd"
  command -v rg >/dev/null 2>&1 || missing="$missing rg"
  if [ -n "$missing" ]; then
    echo "missing required host executables:" >&2
    for executable in $missing; do echo "  $executable" >&2; done
    echo "install Homebrew coreutils, findutils, grep, gawk, fd, and ripgrep, then retry" >&2
    exit 1
  fi
fi

release_root=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
payload="$release_root/payload/pi-sandbox"
candidate="$payload/pi-sandbox"
checksums="$release_root/SHA256SUMS"
defaults_config="$payload/defaults/config.toml"
defaults_models="$payload/defaults/models.json"
[ -f "$checksums" ] && [ ! -L "$checksums" ] || { echo "release SHA256SUMS is missing" >&2; exit 1; }
[ -d "$payload" ] && [ ! -L "$payload" ] || { echo "release payload is missing" >&2; exit 1; }
[ -f "$candidate" ] && [ -x "$candidate" ] && [ ! -L "$candidate" ] || { echo "release executable is invalid" >&2; exit 1; }
[ -f "$defaults_config" ] && [ -f "$defaults_models" ] || { echo "release defaults are incomplete" >&2; exit 1; }
[ -z "$(find "$payload" ! -type d ! -type f -print -quit)" ] || {
  echo "release payload contains an unsupported file type" >&2
  exit 1
}
awk '
  NF != 2 || $1 !~ /^[0-9a-f]{64}$/ || $2 !~ /^payload\/pi-sandbox\// || $2 ~ /(^|\/)\.\.(\/|$)/ { exit 1 }
' "$checksums" || {
  echo "release SHA256SUMS has an invalid entry" >&2
  exit 1
}
payload_file_count=$(find "$payload" -type f | wc -l)
checksum_count=$(wc -l < "$checksums")
[ "$payload_file_count" -eq "$checksum_count" ] || {
  echo "release SHA256SUMS does not inventory the complete payload" >&2
  exit 1
}
(CDPATH= cd "$release_root" && shasum -a 256 -c SHA256SUMS >/dev/null) || {
  echo "release payload checksum verification failed" >&2
  exit 1
}

root_prefix=${destdir:-}
install_base="$root_prefix/usr/local/libexec/pi-sandbox"
libexec_parent=${install_base%/*}
launcher="$root_prefix/usr/local/bin/pi-sandbox"
bin_target=${launcher%/*}
etc_target="$root_prefix/etc/pi-sandbox"
config="$etc_target/config.toml"
models="$etc_target/models.json"
expected_link=../libexec/pi-sandbox/pi-sandbox
path_exists() { [ -e "$1" ] || [ -L "$1" ]; }
require_regular() { [ -f "$1" ] && [ ! -L "$1" ] || { echo "$2 must be a regular file" >&2; exit 1; }; }

for parent in "$libexec_parent" "$bin_target" "$etc_target"; do
  if path_exists "$parent"; then [ -d "$parent" ] && [ ! -L "$parent" ] || { echo "invalid installation parent: $parent" >&2; exit 1; }; fi
done
if path_exists "$launcher"; then
  [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$expected_link" ] || { echo "existing launcher is not managed by Pi Sandbox" >&2; exit 1; }
fi
if path_exists "$install_base"; then [ -d "$install_base" ] && [ ! -L "$install_base" ] || { echo "existing installation is invalid" >&2; exit 1; }; fi

config_present=0
models_present=0
if path_exists "$config"; then require_regular "$config" configuration; config_present=1; fi
if path_exists "$models"; then require_regular "$models" models.json; models_present=1; fi
if [ "$config_present" -eq 0 ] && [ "$models_present" -eq 1 ] && [ "$replace_config" -eq 0 ]; then
  echo "models.json exists without config.toml; use --replace-config" >&2
  exit 1
fi

mkdir -p "$libexec_parent" "$bin_target" "$etc_target"
chmod 0755 "$libexec_parent" "$bin_target" "$etc_target"
lock_dir="$libexec_parent/.pi-sandbox.install.lock"
mkdir "$lock_dir" 2>/dev/null || { echo "another Pi Sandbox installation is in progress" >&2; exit 1; }
stage=
old_code=
validation_root=
config_stage=
models_stage=
backup_config=
backup_models=
config_committed=0
models_committed=0
code_committed=0
launcher_created=0
complete=0
cleanup() {
  status=$?
  set +e
  if [ "$complete" -eq 0 ]; then
    if [ "$config_committed" -eq 1 ]; then
      if [ "$config_present" -eq 1 ] && [ -f "$backup_config" ]; then cp -p "$backup_config" "$config"; else rm -f "$config"; fi
    fi
    if [ "$models_committed" -eq 1 ]; then
      if [ "$models_present" -eq 1 ] && [ -f "$backup_models" ]; then cp -p "$backup_models" "$models"; else rm -f "$models"; fi
    fi
    [ "$launcher_created" -eq 0 ] || rm -f "$launcher"
    [ "$code_committed" -eq 0 ] || rm -rf "$install_base"
    if [ -n "$old_code" ] && [ -d "$old_code" ]; then mv "$old_code" "$install_base"; old_code=; fi
  fi
  [ -z "$config_stage" ] || rm -f "$config_stage"
  [ -z "$models_stage" ] || rm -f "$models_stage"
  [ -z "$stage" ] || rm -rf "$stage"
  [ -z "$old_code" ] || rm -rf "$old_code"
  [ -z "$validation_root" ] || rm -rf "$validation_root"
  rmdir "$lock_dir" 2>/dev/null
  exit "$status"
}
trap cleanup EXIT
trap 'exit 1' HUP INT TERM

if [ "$config_present" -eq 1 ] && [ "$replace_config" -eq 0 ]; then
  if [ -n "$destdir" ]; then
    "$candidate" --validate-installation --root "$destdir"
    execution_backend=$("$candidate" --print-execution-backend --root "$destdir")
  else
    "$candidate" --validate-installation
    execution_backend=$("$candidate" --print-execution-backend)
  fi
else
  validation_root=$(mktemp -d "${TMPDIR:-/tmp}/pi-sandbox-validate.XXXXXX")
  mkdir -p "$validation_root/etc/pi-sandbox"
  install -m 0644 "$defaults_config" "$validation_root/etc/pi-sandbox/config.toml"
  install -m 0644 "$defaults_models" "$validation_root/etc/pi-sandbox/models.json"
  "$candidate" --validate-installation --root "$validation_root"
  execution_backend=$("$candidate" --print-execution-backend --root "$validation_root")
fi
[ "$execution_backend" = direct ] || { echo "macOS packages require direct execution" >&2; exit 1; }

stage=$(mktemp -d "$libexec_parent/.pi-sandbox-stage.XXXXXX")
cp -R "$payload/." "$stage/"
find "$stage" -type d -exec chmod 0755 {} \;
find "$stage" -type f -exec chmod 0644 {} \;
chmod 0755 "$stage/pi-sandbox"
install_defaults=0
if [ "$config_present" -eq 0 ] || [ "$replace_config" -eq 1 ]; then
  install_defaults=1
  config_stage=$(mktemp "$etc_target/.config.toml.XXXXXX")
  models_stage=$(mktemp "$etc_target/.models.json.XXXXXX")
  install -m 0644 "$defaults_config" "$config_stage"
  install -m 0644 "$defaults_models" "$models_stage"
  if [ "$replace_config" -eq 1 ]; then
    backup_base=$(date -u +%Y%m%d_%H%M%S)
    backup_id=$backup_base
    backup_counter=0
    backup_config="$config.bak.$backup_id"
    backup_models="$models.bak.$backup_id"
    while path_exists "$backup_config" || path_exists "$backup_models"; do
      backup_counter=$((backup_counter + 1))
      backup_id="${backup_base}_$backup_counter"
      backup_config="$config.bak.$backup_id"
      backup_models="$models.bak.$backup_id"
    done
    [ "$config_present" -eq 0 ] || cp -p "$config" "$backup_config"
    [ "$models_present" -eq 0 ] || cp -p "$models" "$backup_models"
  fi
fi
if path_exists "$install_base"; then old_code="$libexec_parent/.pi-sandbox-previous.$$"; mv "$install_base" "$old_code"; fi
mv "$stage" "$install_base"
stage=
code_committed=1

if [ "$install_defaults" -eq 1 ]; then
  mv -f "$models_stage" "$models"
  models_stage=
  models_committed=1
  mv -f "$config_stage" "$config"
  config_stage=
  config_committed=1
fi
if ! path_exists "$launcher"; then ln -s "$expected_link" "$launcher"; launcher_created=1; fi
complete=1
echo "installed Pi Sandbox direct-execution package:"
echo "  $install_base/pi-sandbox"
echo "  $launcher -> $install_base/pi-sandbox"
echo "  $config"
echo "  $models"
