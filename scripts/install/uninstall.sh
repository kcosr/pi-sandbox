#!/bin/sh
set -eu
configuration_source=local

usage() {
  echo "usage: uninstall.sh [--remove-config]" >&2
  exit 2
}

remove_config=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --remove-config) [ "$configuration_source" = local ] || { echo "--remove-config requires a local configuration build" >&2; exit 2; }; remove_config=1; shift ;;
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
root_prefix=${destdir:-}
launcher="${root_prefix}/usr/bin/pi-sandbox"
install_base="${root_prefix}/usr/libexec/pi-sandbox"
etc_target="${root_prefix}/etc/pi-sandbox"
config="$etc_target/config.toml"
models="$etc_target/models.json"
expected_link="../libexec/pi-sandbox/pi-sandbox"

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
[ ! -e "$install_base" ] && [ ! -L "$install_base" ] || rm -rf -- "$install_base"

if [ "$remove_config" -eq 1 ]; then
  for active in "$config" "$models"; do
    [ ! -e "$active" ] && [ ! -L "$active" ] || rm -f -- "$active"
  done
  rmdir "$etc_target" 2>/dev/null || true
fi

echo "uninstalled pi-sandbox; configuration $([ "$remove_config" -eq 1 ] && echo removed || echo retained)"
