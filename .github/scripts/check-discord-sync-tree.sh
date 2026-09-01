#!/usr/bin/env bash

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: check-discord-sync-tree.sh <old-fork-head> <new-head>" >&2
  exit 2
fi

git diff --exit-code "$1" "$2" -- external_plugins/discord/
