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
newline='
'
case "$destdir" in
  *"$newline"*) echo "DESTDIR must contain only printable ASCII characters" >&2; exit 2 ;;
esac
if printf '%s' "$destdir" | LC_ALL=C /bin/grep -q '[^ -~]'; then
  echo "DESTDIR must contain only printable ASCII characters" >&2
  exit 2
fi
case "$destdir" in
  ""|/) destdir= ;;
  /*)
    while [ "${destdir%/}" != "$destdir" ]; do destdir=${destdir%/}; done
    ;;
  *) echo "DESTDIR must be an absolute path" >&2; exit 2 ;;
esac
if [ -z "$destdir" ] && [ "$(id -u)" -ne 0 ]; then
  echo "system installation must run as root" >&2
  exit 1
fi
if [ -z "$destdir" ]; then
  required_executables='/bin/bash
/bin/sh
/bin/cat
/bin/chmod
/bin/mkdir
/bin/mv
/bin/rm
/bin/grep
/usr/bin/file
/usr/bin/find
/usr/bin/awk
/usr/bin/head
/usr/bin/sha256sum
/usr/bin/sort
/usr/bin/tail
/usr/bin/test
/usr/bin/wc'
  missing_executables=
  for executable in $required_executables; do
    if [ ! -x "$executable" ]; then
      missing_executables="$missing_executables $executable"
    fi
  done
  if ! command -v fd >/dev/null 2>&1 && ! command -v fdfind >/dev/null 2>&1; then
    missing_executables="$missing_executables fd-or-fdfind"
  fi
  if ! command -v rg >/dev/null 2>&1; then
    missing_executables="$missing_executables rg"
  fi
  if [ -n "$missing_executables" ]; then
    echo "missing required host executables:" >&2
    for executable in $missing_executables; do echo "  $executable" >&2; done
    echo "install the operating-system packages that provide them, then retry" >&2
    exit 1
  fi
fi

release_root=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
checksums="$release_root/SHA256SUMS"
payload="$release_root/payload/pi-sandbox"
bubblewrap_mode=system
bubblewrap_runtime="/usr/bin/bwrap"
bundled_bubblewrap="$payload/bwrap"
candidate="$payload/pi-sandbox"
candidate_broker="$payload/pi-sandbox-identity-broker"
candidate_audit="$payload/pi-sandbox-audit-collector"
audit_socket_unit_source="$payload/systemd/pi-sandbox-audit.socket"
audit_service_unit_source="$payload/systemd/pi-sandbox-audit@.service"
defaults_config="$payload/defaults/config.toml"
defaults_models="$payload/defaults/models.json"
socket_unit_source="$payload/systemd/pi-sandbox-identity-broker.socket"
service_unit_source="$payload/systemd/pi-sandbox-identity-broker@.service"

[ -f "$checksums" ] && [ ! -L "$checksums" ] || {
  echo "release SHA256SUMS is missing or invalid" >&2
  exit 1
}
[ -d "$payload" ] && [ ! -L "$payload" ] || {
  echo "release payload is missing or invalid" >&2
  exit 1
}
[ -z "$(find "$payload" ! -type d ! -type f -print -quit)" ] || {
  echo "release payload contains an unsupported file type" >&2
  exit 1
}
[ -f "$candidate" ] && [ ! -L "$candidate" ] && [ -x "$candidate" ] || {
  echo "release executable is missing or invalid" >&2
  exit 1
}
for required in "$payload/sbom.cdx.json" "$candidate_audit" "$audit_socket_unit_source" "$audit_service_unit_source" "$candidate_broker" "$defaults_config" "$defaults_models" "$socket_unit_source" "$service_unit_source" "$payload/release-manifest.json"; do
  [ -f "$required" ] && [ ! -L "$required" ] || {
    echo "release payload is incomplete" >&2
    exit 1
  }
done
[ -x "$candidate_broker" ] || {
  echo "release identity broker is not executable" >&2
  exit 1
}
[ -x "$candidate_audit" ] || {
  echo "release audit collector is not executable" >&2
  exit 1
}
case "$bubblewrap_mode" in
  system) ;;
  bundled)
    [ -f "$bundled_bubblewrap" ] && [ ! -L "$bundled_bubblewrap" ] && [ -x "$bundled_bubblewrap" ] || {
      echo "release bundled Bubblewrap executable is missing or invalid" >&2
      exit 1
    }
    ;;
  *) echo "release has an invalid Bubblewrap provider" >&2; exit 1 ;;
esac
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
(CDPATH= cd -- "$release_root" && sha256sum -c SHA256SUMS >/dev/null) || {
  echo "release payload checksum verification failed" >&2
  exit 1
}

root_prefix=${destdir:-}
install_base="${root_prefix}/usr/libexec/pi-sandbox"
libexec_parent=${install_base%/*}
etc_target="${root_prefix}/etc/pi-sandbox"
launcher="${root_prefix}/usr/bin/pi-sandbox"
bin_target=${launcher%/*}
systemd_target="${root_prefix}/usr/lib/systemd/system"
socket_unit="$systemd_target/pi-sandbox-identity-broker.socket"
audit_socket_unit="$systemd_target/pi-sandbox-audit.socket"
service_unit="$systemd_target/pi-sandbox-identity-broker@.service"
audit_service_unit="$systemd_target/pi-sandbox-audit@.service"
config="$etc_target/config.toml"
models="$etc_target/models.json"
expected_link=../libexec/pi-sandbox/pi-sandbox
expected_socket_unit_link=../../../libexec/pi-sandbox/systemd/pi-sandbox-identity-broker.socket
expected_audit_socket_unit_link=../../../libexec/pi-sandbox/systemd/pi-sandbox-audit.socket
expected_service_unit_link=../../../libexec/pi-sandbox/systemd/pi-sandbox-identity-broker@.service
expected_audit_service_unit_link=../../../libexec/pi-sandbox/systemd/pi-sandbox-audit@.service

path_exists() { [ -e "$1" ] || [ -L "$1" ]; }
require_regular() {
  [ -f "$1" ] && [ ! -L "$1" ] || {
    echo "existing $2 must be a regular non-symlink file" >&2
    exit 1
  }
}

for parent in "$libexec_parent" "$etc_target" "$bin_target" "$systemd_target"; do
  if path_exists "$parent"; then
    [ -d "$parent" ] && [ ! -L "$parent" ] || {
      echo "installation destination parent must be a regular directory" >&2
      exit 1
    }
  fi
done

if path_exists "$install_base"; then
  [ -d "$install_base" ] && [ ! -L "$install_base" ] || {
    echo "existing installation must be a regular directory" >&2
    exit 1
  }
fi
if path_exists "$launcher"; then
  [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$expected_link" ] || {
    echo "existing /usr/bin/pi-sandbox is not the managed symlink" >&2
    exit 1
  }
fi
if path_exists "$socket_unit"; then
  [ -L "$socket_unit" ] && [ "$(readlink "$socket_unit")" = "$expected_socket_unit_link" ] || {
    echo "existing pi-sandbox identity broker socket unit is not the managed symlink" >&2
    exit 1
  }
fi
if path_exists "$service_unit"; then
  [ -L "$service_unit" ] && [ "$(readlink "$service_unit")" = "$expected_service_unit_link" ] || {
    echo "existing pi-sandbox identity broker service unit is not the managed symlink" >&2
    exit 1
  }
fi
if path_exists "$audit_socket_unit"; then
  [ -L "$audit_socket_unit" ] && [ "$(readlink "$audit_socket_unit")" = "$expected_audit_socket_unit_link" ] || {
    echo "existing pi-sandbox audit collector socket unit is not the managed symlink" >&2
    exit 1
  }
fi
if path_exists "$audit_service_unit"; then
  [ -L "$audit_service_unit" ] && [ "$(readlink "$audit_service_unit")" = "$expected_audit_service_unit_link" ] || {
    echo "existing pi-sandbox audit collector service unit is not the managed symlink" >&2
    exit 1
  }
fi
config_present=0
models_present=0
if path_exists "$config"; then require_regular "$config" configuration; config_present=1; fi
if path_exists "$models"; then require_regular "$models" models.json; models_present=1; fi
if [ "$config_present" -eq 0 ] && [ "$models_present" -eq 1 ] && [ "$replace_config" -eq 0 ]; then
  echo "models.json exists without config.toml; use --replace-config to repair the installation" >&2
  exit 1
fi

mkdir -p "$libexec_parent" "$etc_target" "$bin_target" "$systemd_target"
chmod 0755 "$libexec_parent" "$etc_target" "$bin_target" "$systemd_target"
lock_dir="$libexec_parent/.pi-sandbox.install.lock"
mkdir "$lock_dir" 2>/dev/null || {
  echo "another pi-sandbox installation is in progress; if it was interrupted, verify no installer is running and remove $lock_dir" >&2
  exit 1
}

stage=
validation_root=
config_stage=
models_stage=
link_stage=
launcher_created=0
socket_unit_stage=
audit_socket_unit_stage=
service_unit_stage=
audit_service_unit_stage=
socket_unit_created=0
audit_socket_unit_created=0
service_unit_created=0
audit_service_unit_created=0
code_committed=0
old_code_moved=0
old_code_path=
config_transaction=0
config_committed=0
models_committed=0
installation_complete=0
backup_config=
backup_models=

rollback_file() {
  destination=$1
  backup=$2
  existed=$3
  temporary="$destination.rollback.$$"
  if [ "$existed" -eq 1 ] && [ -n "$backup" ] && [ -f "$backup" ]; then
    cp -p -- "$backup" "$temporary" && mv -Tf -- "$temporary" "$destination"
  else
    rm -f -- "$destination" "$temporary"
  fi
}

cleanup() {
  status=$?
  set +e
  if [ "$installation_complete" -eq 0 ]; then
    if [ "$config_transaction" -eq 1 ]; then
      [ "$config_committed" -eq 0 ] || rollback_file "$config" "$backup_config" "$config_present"
      [ "$models_committed" -eq 0 ] || rollback_file "$models" "$backup_models" "$models_present"
    fi
    if [ "$code_committed" -eq 1 ] && path_exists "$install_base"; then
      rm -rf -- "$install_base"
    fi
    if [ "$old_code_moved" -eq 1 ] && [ -n "$old_code_path" ] && [ -d "$old_code_path" ]; then
      mv -T -- "$old_code_path" "$install_base" >/dev/null 2>&1 || true
    fi
    [ "$socket_unit_created" -eq 0 ] || rm -f -- "$socket_unit"
    [ "$audit_socket_unit_created" -eq 0 ] || rm -f -- "$audit_socket_unit"
    [ "$service_unit_created" -eq 0 ] || rm -f -- "$service_unit"
    [ "$audit_service_unit_created" -eq 0 ] || rm -f -- "$audit_service_unit"
    [ "$launcher_created" -eq 0 ] || rm -f -- "$launcher"
  fi
  [ -z "$config_stage" ] || rm -f -- "$config_stage"
  [ -z "$models_stage" ] || rm -f -- "$models_stage"
  [ -z "$link_stage" ] || rm -f -- "$link_stage"
  [ -z "$socket_unit_stage" ] || rm -f -- "$socket_unit_stage"
  [ -z "$audit_socket_unit_stage" ] || rm -f -- "$audit_socket_unit_stage"
  [ -z "$service_unit_stage" ] || rm -f -- "$service_unit_stage"
  [ -z "$audit_service_unit_stage" ] || rm -f -- "$audit_service_unit_stage"
  [ -z "$stage" ] || rm -rf -- "$stage"
  [ -z "$old_code_path" ] || rm -rf -- "$old_code_path"
  [ -z "$validation_root" ] || rm -rf -- "$validation_root"
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
  validation_root=$(mktemp -d)
  mkdir -p "$validation_root/etc/pi-sandbox"
  install -m 0644 "$defaults_config" "$validation_root/etc/pi-sandbox/config.toml"
  install -m 0644 "$defaults_models" "$validation_root/etc/pi-sandbox/models.json"
  "$candidate" --validate-installation --root "$validation_root"
  execution_backend=$("$candidate" --print-execution-backend --root "$validation_root")
fi
case "$execution_backend" in
  bubblewrap)
    if [ -z "$destdir" ]; then
      if [ "$bubblewrap_mode" = system ]; then
        bubblewrap_probe=$bubblewrap_runtime
      else
        bubblewrap_probe=$bundled_bubblewrap
      fi
      if [ ! -x "$bubblewrap_probe" ]; then
        echo "Bubblewrap execution is configured but $bubblewrap_probe is unavailable" >&2
        exit 1
      fi
      bubblewrap_help=$("$bubblewrap_probe" --help 2>&1) || {
        echo "Bubblewrap execution is configured but $bubblewrap_probe cannot run" >&2
        exit 1
      }
      for required_option in --unshare-user --disable-userns --assert-userns-disabled --json-status-fd --seccomp --remount-ro --ro-bind-data; do
        case "$bubblewrap_help" in
          *"$required_option"*) ;;
          *)
            echo "Bubblewrap $bubblewrap_probe does not support required option $required_option" >&2
            exit 1
            ;;
        esac
      done
    fi
    ;;
  direct) ;;
  smolvm)
    # Administrative validation already checked the build-selected provider and
    # policy shape. Runtime startup verifies the complete external distribution
    # and image before launch; staged installation must not require host KVM.
    ;;
  *) echo "candidate reported an invalid execution backend" >&2; exit 1 ;;
esac

stage=$(mktemp -d "$libexec_parent/.pi-sandbox.staging.XXXXXX")
cp -R "$payload/." "$stage/"
find "$stage" -type d -exec chmod 0755 {} +
find "$stage" -type f -exec chmod 0644 {} +
chmod 0755 "$stage/pi-sandbox"
chmod 0755 "$stage/pi-sandbox-identity-broker"
chmod 0755 "$stage/pi-sandbox-audit-collector"
if [ "$bubblewrap_mode" = bundled ]; then chmod 0755 "$stage/bwrap"; fi

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
    if [ "$config_present" -eq 1 ]; then cp -p -- "$config" "$backup_config"; fi
    if [ "$models_present" -eq 1 ]; then cp -p -- "$models" "$backup_models"; fi
  fi
fi

if path_exists "$install_base"; then
  old_code_path="${stage}.previous"
  old_code_moved=1
  mv -T -- "$install_base" "$old_code_path"
fi
code_committed=1
mv -T -- "$stage" "$install_base"
stage=

if [ "$install_defaults" -eq 1 ]; then
  config_transaction=1
  models_committed=1
  mv -Tf -- "$models_stage" "$models"
  models_stage=
  config_committed=1
  mv -Tf -- "$config_stage" "$config"
  config_stage=
fi

if ! path_exists "$launcher"; then
  link_stage="$bin_target/.pi-sandbox.$$"
  [ ! -e "$link_stage" ] && [ ! -L "$link_stage" ] || {
    echo "temporary launcher path already exists" >&2
    exit 1
  }
  ln -s "$expected_link" "$link_stage"
  launcher_created=1
  mv -Tf -- "$link_stage" "$launcher"
  link_stage=
fi

if ! path_exists "$socket_unit"; then
  socket_unit_stage="$systemd_target/.pi-sandbox-identity-broker.socket.$$"
  [ ! -e "$socket_unit_stage" ] && [ ! -L "$socket_unit_stage" ] || {
    echo "temporary socket unit path already exists" >&2
    exit 1
  }
  ln -s "$expected_socket_unit_link" "$socket_unit_stage"
  socket_unit_created=1
  mv -Tf -- "$socket_unit_stage" "$socket_unit"
  socket_unit_stage=
fi
if ! path_exists "$service_unit"; then
  service_unit_stage="$systemd_target/.pi-sandbox-identity-broker@.service.$$"
  [ ! -e "$service_unit_stage" ] && [ ! -L "$service_unit_stage" ] || {
    echo "temporary service unit path already exists" >&2
    exit 1
  }
  ln -s "$expected_service_unit_link" "$service_unit_stage"
  service_unit_created=1
  mv -Tf -- "$service_unit_stage" "$service_unit"
  service_unit_stage=
fi

if ! path_exists "$audit_socket_unit"; then
  audit_socket_unit_stage="$systemd_target/.pi-sandbox-audit.socket.$$"
  [ ! -e "$audit_socket_unit_stage" ] && [ ! -L "$audit_socket_unit_stage" ] || {
    echo "temporary socket unit path already exists" >&2
    exit 1
  }
  ln -s "$expected_audit_socket_unit_link" "$audit_socket_unit_stage"
  audit_socket_unit_created=1
  mv -Tf -- "$audit_socket_unit_stage" "$audit_socket_unit"
  audit_socket_unit_stage=
fi
if ! path_exists "$audit_service_unit"; then
  audit_service_unit_stage="$systemd_target/.pi-sandbox-audit@.service.$$"
  [ ! -e "$audit_service_unit_stage" ] && [ ! -L "$audit_service_unit_stage" ] || {
    echo "temporary service unit path already exists" >&2
    exit 1
  }
  ln -s "$expected_audit_service_unit_link" "$audit_service_unit_stage"
  audit_service_unit_created=1
  mv -Tf -- "$audit_service_unit_stage" "$audit_service_unit"
  audit_service_unit_stage=
fi

installation_complete=1
if [ "$install_defaults" -eq 0 ]; then
  config_action=preserved
  models_action=preserved
else
  [ "$config_present" -eq 1 ] && config_action=replaced || config_action=installed
  [ "$models_present" -eq 1 ] && models_action=replaced || models_action=installed
fi

printf '%s\n' "installed pi-sandbox files:"
printf '  %s (executable)\n' "$install_base/pi-sandbox"
printf '  %s (identity broker executable)\n' "$install_base/pi-sandbox-identity-broker"
printf '  %s (audit collector executable)\n' "$install_base/pi-sandbox-audit-collector"
if [ "$bubblewrap_mode" = bundled ]; then
  printf '  %s (bundled Bubblewrap executable)\n' "$install_base/bwrap"
else
  printf '  %s (system Bubblewrap executable, not managed)\n' "$bubblewrap_runtime"
fi
printf '  %s -> %s\n' "$launcher" "$install_base/pi-sandbox"
printf '  %s (runtime support files)\n' "$install_base/"
printf '  %s -> %s\n' "$socket_unit" "$install_base/systemd/pi-sandbox-identity-broker.socket"
printf '  %s -> %s\n' "$audit_socket_unit" "$install_base/systemd/pi-sandbox-audit.socket"
printf '  %s -> %s\n' "$service_unit" "$install_base/systemd/pi-sandbox-identity-broker@.service"
printf '  %s -> %s\n' "$audit_service_unit" "$install_base/systemd/pi-sandbox-audit@.service"
printf '%s\n' "live administrator configuration:"
printf '  %s (%s)\n' "$config" "$config_action"
if [ "$install_defaults" -eq 1 ] || [ "$models_present" -eq 1 ]; then
  printf '  %s (%s)\n' "$models" "$models_action"
fi
if [ "$config_present" -eq 1 ] && [ "$replace_config" -eq 1 ]; then
  printf '  %s (configuration backup)\n' "$backup_config"
fi
if [ "$models_present" -eq 1 ] && [ "$replace_config" -eq 1 ]; then
  printf '  %s (model catalog backup)\n' "$backup_models"
fi
printf '%s\n' "optional administrator-managed identity overrides (directories not installed or replaced):"
printf '  %s\n' "$etc_target/users.d/"
printf '  %s\n' "$etc_target/groups.d/"
