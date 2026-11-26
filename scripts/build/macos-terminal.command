#!/bin/sh
set -eu

resources=$(CDPATH= cd -- "$(/usr/bin/dirname "$0")" && pwd -P)
cd -- "$HOME"
exec "$resources/../MacOS/pi-sandbox"
