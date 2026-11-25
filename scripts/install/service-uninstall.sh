#!/bin/sh
set -eu
[ "$#" -eq 0 ] || { echo "usage: uninstall.sh" >&2; exit 2; }
destdir=${DESTDIR:-}
case "$destdir" in ""|/) destdir= ;; /*) while [ "${destdir%/}" != "$destdir" ]; do destdir=${destdir%/}; done ;; *) echo "DESTDIR must be absolute" >&2; exit 2 ;; esac
if [ -z "$destdir" ]; then
  [ "$(id -u)" -eq 0 ] || { echo "live uninstall requires root" >&2; exit 1; }
  if [ -d /run/systemd/system ]; then
    command -v systemctl >/dev/null || { echo "systemctl is required" >&2; exit 1; }
    if systemctl is-active --quiet pi-sandbox-service.service || systemctl is-enabled --quiet pi-sandbox-service.service; then echo "disable and stop pi-sandbox-service.service before uninstalling" >&2; exit 1; fi
  fi
fi
base="$destdir/usr/libexec/pi-sandbox-service"
unit="$destdir/usr/lib/systemd/system/pi-sandbox-service.service"
examples="$destdir/usr/share/pi-sandbox-service/examples"
for path in "$base" "$examples"; do [ ! -e "$path" ] && [ ! -L "$path" ] || { [ -d "$path" ] && [ ! -L "$path" ]; } || { echo "invalid installed directory" >&2; exit 1; }; done
[ ! -e "$unit" ] && [ ! -L "$unit" ] || { [ -f "$unit" ] && [ ! -L "$unit" ]; } || { echo "invalid installed unit" >&2; exit 1; }
rm -rf "$base" "$examples"; rm -f "$unit"
echo "uninstalled service; deployment-owned configuration and credentials retained"
