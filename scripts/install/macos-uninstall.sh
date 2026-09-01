#!/bin/sh
set -eu

remove_config=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --remove-config) remove_config=1; shift ;;
    *) echo "usage: uninstall.sh [--remove-config]" >&2; exit 2 ;;
  esac
done
destdir=${DESTDIR:-}
case "$destdir" in ""|/) destdir= ;; /*) while [ "${destdir%/}" != "$destdir" ]; do destdir=${destdir%/}; done ;; *) echo "DESTDIR must be absolute" >&2; exit 2 ;; esac
if [ -z "$destdir" ] && [ "$(id -u)" -ne 0 ]; then echo "system uninstall must run as root" >&2; exit 1; fi
if [ -z "$destdir" ]; then [ "$(uname -s)" = Darwin ] || { echo "this package requires macOS" >&2; exit 1; }; fi

launcher="$destdir/usr/local/bin/pi-sandbox"
install_base="$destdir/usr/local/libexec/pi-sandbox"
etc_target="$destdir/etc/pi-sandbox"
expected_link=../libexec/pi-sandbox/pi-sandbox
if [ -e "$launcher" ] || [ -L "$launcher" ]; then
  [ -L "$launcher" ] && [ "$(readlink "$launcher")" = "$expected_link" ] || { echo "launcher is not managed by Pi Sandbox" >&2; exit 1; }
fi
if [ -e "$install_base" ] || [ -L "$install_base" ]; then
  [ -d "$install_base" ] && [ ! -L "$install_base" ] || { echo "installed path is invalid" >&2; exit 1; }
fi
if [ "$remove_config" -eq 1 ]; then
  for file in "$etc_target/config.toml" "$etc_target/models.json"; do
    if [ -e "$file" ] || [ -L "$file" ]; then [ -f "$file" ] && [ ! -L "$file" ] || { echo "configuration path is invalid" >&2; exit 1; }; fi
  done
fi
[ ! -e "$launcher" ] && [ ! -L "$launcher" ] || rm -f "$launcher"
[ ! -e "$install_base" ] && [ ! -L "$install_base" ] || rm -rf "$install_base"
if [ "$remove_config" -eq 1 ]; then
  rm -f "$etc_target/config.toml" "$etc_target/models.json"
  rmdir "$etc_target" 2>/dev/null || true
fi
echo "uninstalled Pi Sandbox; configuration $([ "$remove_config" -eq 1 ] && echo removed || echo retained)"
