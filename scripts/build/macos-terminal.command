#!/bin/sh
set -eu

resources=$(CDPATH= cd -- "$(/usr/bin/dirname "$0")" && pwd -P)
home=$(CDPATH= cd -P -- "$HOME" && pwd -P)
workspace="$home/Pi Sandbox Workspace"
if [ -L "$workspace" ] || ! (umask 077; /bin/mkdir -p -- "$workspace") ||
  ! CDPATH= cd -P -- "$workspace" || [ "$(pwd -P)" != "$workspace" ]; then
  printf '%s\n' "Pi Sandbox: Cannot open Finder workspace: $workspace" >&2
  exit 1
fi
exec "$resources/../MacOS/pi-sandbox"
