#!/bin/sh
set -eu

usage() {
  echo "usage: uninstall.sh [--remove-config]" >&2
  exit 2
}

remove_config=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --remove-config) remove_config=1; shift ;;
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
  echo "system uninstall must run as root" >&2
  exit 1
fi
systemd_live=0
if [ -z "$destdir" ] && [ -d /run/systemd/system ]; then
  systemd_live=1
  command -v systemctl >/dev/null 2>&1 || {
    echo "systemctl is required to verify identity broker service state" >&2
    exit 1
  }
  if systemctl is-active --quiet pi-sandbox-identity-broker.socket || \
     systemctl is-enabled --quiet pi-sandbox-identity-broker.socket; then
    echo "disable the identity broker before uninstalling:" >&2
    echo "  systemctl disable --now pi-sandbox-identity-broker.socket" >&2
    exit 1
  fi
fi

root_prefix=${destdir:-}
launcher="${root_prefix}/usr/bin/pi-sandbox"
install_base="${root_prefix}/usr/libexec/pi-sandbox"
systemd_target="${root_prefix}/usr/lib/systemd/system"
socket_unit="$systemd_target/pi-sandbox-identity-broker.socket"
service_unit="$systemd_target/pi-sandbox-identity-broker@.service"
etc_target="${root_prefix}/etc/pi-sandbox"
config="$etc_target/config.toml"
models="$etc_target/models.json"
expected_link=../libexec/pi-sandbox/pi-sandbox
expected_socket_unit_link=../../../libexec/pi-sandbox/systemd/pi-sandbox-identity-broker.socket
expected_service_unit_link=../../../libexec/pi-sandbox/systemd/pi-sandbox-identity-broker@.service

# Validate every managed target before removing any of them.
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$expected_link" ] || {
    echo "existing /usr/bin/pi-sandbox is not the managed symlink" >&2
    exit 1
  }
fi
if [ -e "$install_base" ] || [ -L "$install_base" ]; then
  [ -d "$install_base" ] && [ ! -L "$install_base" ] || {
    echo "installed pi-sandbox path is not a regular directory" >&2
    exit 1
  }
fi
if [ -e "$socket_unit" ] || [ -L "$socket_unit" ]; then
  [ -L "$socket_unit" ] && [ "$(readlink "$socket_unit")" = "$expected_socket_unit_link" ] || {
    echo "installed pi-sandbox identity broker socket unit is not the managed symlink" >&2
    exit 1
  }
fi
if [ -e "$service_unit" ] || [ -L "$service_unit" ]; then
  [ -L "$service_unit" ] && [ "$(readlink "$service_unit")" = "$expected_service_unit_link" ] || {
    echo "installed pi-sandbox identity broker service unit is not the managed symlink" >&2
    exit 1
  }
fi
if [ "$remove_config" -eq 1 ]; then
  for active in "$config" "$models"; do
    if [ -e "$active" ] || [ -L "$active" ]; then
      [ -f "$active" ] && [ ! -L "$active" ] || {
        echo "active configuration path is not a regular non-symlink file" >&2
        exit 1
      }
    fi
  done
fi

[ ! -e "$launcher" ] && [ ! -L "$launcher" ] || rm -f -- "$launcher"
[ ! -e "$socket_unit" ] && [ ! -L "$socket_unit" ] || rm -f -- "$socket_unit"
[ ! -e "$service_unit" ] && [ ! -L "$service_unit" ] || rm -f -- "$service_unit"
[ ! -e "$install_base" ] && [ ! -L "$install_base" ] || rm -rf -- "$install_base"

if [ "$systemd_live" -eq 1 ]; then
  systemctl daemon-reload
fi

if [ "$remove_config" -eq 1 ]; then
  for active in "$config" "$models"; do
    [ ! -e "$active" ] && [ ! -L "$active" ] || rm -f -- "$active"
  done
  rmdir "$etc_target" 2>/dev/null || true
fi

echo "uninstalled pi-sandbox; configuration $([ "$remove_config" -eq 1 ] && echo removed || echo retained)"
