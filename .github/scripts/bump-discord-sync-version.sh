#!/usr/bin/env bash

set -euo pipefail

MANIFEST="external_plugins/discord/.claude-plugin/plugin.json"

if [[ ! -f "$MANIFEST" ]]; then
  echo "Discord plugin manifest not found: $MANIFEST" >&2
  exit 1
fi

python3 - "$MANIFEST" <<'PY'
import json
import os
import re
import sys
import tempfile

path = sys.argv[1]
with open(path, encoding="utf-8") as handle:
    manifest = json.load(handle)

version = manifest.get("version")
match = re.fullmatch(r"(\d+)\.(\d+)\.(\d+)", version or "")
if match is None:
    raise SystemExit(f"Discord plugin version must be plain semver, got {version!r}")

major, minor, patch = (int(part) for part in match.groups())
next_version = f"{major}.{minor}.{patch + 1}"
manifest["version"] = next_version

directory = os.path.dirname(path)
fd, temporary = tempfile.mkstemp(prefix=".plugin.json.", dir=directory, text=True)
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        json.dump(manifest, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)

print(next_version)
PY
