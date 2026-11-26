#!/bin/sh
set -eu

PATH=/usr/bin:/bin
export PATH
umask 022

case "${3:-}" in
  /*) volume=${3%/} ;;
  *) echo "Pi Sandbox: Installer did not provide a target volume." >&2; exit 1 ;;
esac

launcher='@BUNDLE_LAUNCHER@'
link="$volume@COMMAND_PATH@"
bin=${link%/*}
for directory in "$volume/usr" "$volume/usr/local" "$bin"; do
  if [ -L "$directory" ] || { [ -e "$directory" ] && [ ! -d "$directory" ]; }; then
    echo "Pi Sandbox: Invalid command directory: $directory" >&2
    exit 1
  fi
done

if [ -e "$link" ] || [ -L "$link" ]; then
  if [ -L "$link" ] && [ "$(readlink "$link")" = "$launcher" ]; then
    exit 0
  fi
  echo "Pi Sandbox: Move the existing $link or uninstall the legacy release before installing." >&2
  exit 1
fi

case "${0##*/}" in
  preinstall) exit 0 ;;
  postinstall) ;;
  *) exit 1 ;;
esac

if [ ! -f "$volume$launcher" ] || [ ! -x "$volume$launcher" ] || [ -L "$volume$launcher" ]; then
  echo "Pi Sandbox: The installed app launcher is missing or invalid." >&2
  exit 1
fi
mkdir -p "$bin"
cd "$bin"
# The single-argument form creates a link with the source basename in this directory.
ln -s "$launcher"
