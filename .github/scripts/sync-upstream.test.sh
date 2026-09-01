#!/usr/bin/env bash

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
WORKFLOW="$REPO_ROOT/.github/workflows/sync-upstream.yml"
GUARD="$REPO_ROOT/.github/scripts/check-discord-sync-tree.sh"
BUMP="$REPO_ROOT/.github/scripts/bump-discord-sync-version.sh"
PLUGIN_MANIFEST="$REPO_ROOT/external_plugins/discord/.claude-plugin/plugin.json"
FAILURES=0

pass() {
  printf 'PASS: %s\n' "$1"
}

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  FAILURES=$((FAILURES + 1))
}

assert_contains() {
  local needle="$1"
  local label="$2"
  if grep -Fq -- "$needle" "$WORKFLOW"; then
    pass "$label"
  else
    fail "$label"
  fi
}

assert_contains 'test_alert:' 'workflow exposes the alert-only drill'
assert_contains 'test_discord_guard:' 'workflow exposes the discord-tree guard drill'
assert_contains 'type: boolean' 'drill inputs use native booleans'
# shellcheck disable=SC2016 # GitHub expression is intentionally matched literally.
assert_contains 'token: ${{ secrets.SYNC_PAT }}' 'checkout uses the workflow-capable PAT'
assert_contains 'group: sync-upstream-main' 'scheduled and manual syncs share one concurrency group'
assert_contains "if: \${{ failure() || inputs.test_alert }}" 'fallback alert runs for every failure and the alert drill'
assert_contains 'curl --fail-with-body --show-error --retry 3' 'webhook delivery fails loudly on HTTP errors'
assert_contains 'jq -n --arg content' 'webhook JSON is built without string interpolation hazards'
assert_contains '!inputs.test_alert && !inputs.test_discord_guard' 'remote mutations carry both drill fences'
assert_contains 'Advance Discord sync version' 'real sync advances the plugin version before push'
assert_contains '.github/scripts/bump-discord-sync-version.sh' 'workflow uses the tested version helper'
assert_contains 'chore(discord): advance sync version' 'workflow keeps one amendable sync-version commit at the tip'

if [[ -x "$GUARD" ]]; then
  pass 'discord-tree guard helper exists and is executable'
else
  fail 'discord-tree guard helper exists and is executable'
fi

if [[ -x "$BUMP" ]]; then
  pass 'sync-version helper exists and is executable'
else
  fail 'sync-version helper exists and is executable'
fi

if [[ "$(jq -r '.version' "$PLUGIN_MANIFEST")" == "0.0.5" ]]; then
  pass 'the first repaired workflow commit publishes a new plugin version'
else
  fail 'the first repaired workflow commit publishes a new plugin version'
fi

if grep -Eq "==[[:space:]]*'true'|'true'[[:space:]]*==" "$WORKFLOW"; then
  fail 'native boolean inputs are not compared with string true'
else
  pass 'native boolean inputs are not compared with string true'
fi

python3 - "$WORKFLOW" <<'PY' || FAILURES=$((FAILURES + 1))
import re
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text()
steps = re.split(r"\n      - name: ", text)[1:]
mutations = {
    "Rebase": "git rebase upstream/main",
    "Force push": "git push origin main --force-with-lease",
    "Open manual-review issue": "gh issue create",
}
failed = False
for expected_name, marker in mutations.items():
    matches = [step for step in steps if marker in step]
    if len(matches) != 1:
        print(f"FAIL: {expected_name} mutation appears exactly once", file=sys.stderr)
        failed = True
        continue
    header = matches[0].splitlines()[0]
    if not header.startswith(expected_name):
        print(f"FAIL: marker {marker!r} belongs to a named {expected_name} step", file=sys.stderr)
        failed = True
    if "!inputs.test_alert && !inputs.test_discord_guard" not in matches[0]:
        print(f"FAIL: {expected_name} carries both drill fences", file=sys.stderr)
        failed = True
    else:
        print(f"PASS: {expected_name} carries both drill fences")
if failed:
    raise SystemExit(1)
PY

python3 - "$WORKFLOW" <<'PY' || FAILURES=$((FAILURES + 1))
import sys
from pathlib import Path

text = Path(sys.argv[1]).read_text()
names = [
    "- name: Guard Discord tree",
    "- name: Advance Discord sync version",
    "- name: Force push",
]
positions = [text.find(name) for name in names]
if -1 in positions or positions != sorted(positions):
    print("FAIL: tree guard runs before the intentional version bump and push", file=sys.stderr)
    raise SystemExit(1)
print("PASS: tree guard runs before the intentional version bump and push")
PY

if [[ -x "$GUARD" ]]; then
  TMP_ROOT="$(mktemp -d)"
  trap 'rm -rf "$TMP_ROOT"' EXIT
  git -C "$TMP_ROOT" init -q
  git -C "$TMP_ROOT" config user.name test
  git -C "$TMP_ROOT" config user.email test@example.com
  mkdir -p "$TMP_ROOT/external_plugins/discord"
  printf 'fork marker\n' > "$TMP_ROOT/external_plugins/discord/server.ts"
  printf 'base\n' > "$TMP_ROOT/README.md"
  git -C "$TMP_ROOT" add .
  git -C "$TMP_ROOT" commit -qm base
  BASE="$(git -C "$TMP_ROOT" rev-parse HEAD)"

  printf 'unrelated\n' >> "$TMP_ROOT/README.md"
  git -C "$TMP_ROOT" add README.md
  git -C "$TMP_ROOT" commit -qm unrelated
  if (cd "$TMP_ROOT" && "$GUARD" "$BASE" HEAD); then
    pass 'guard allows an upstream sync that leaves discord byte-identical'
  else
    fail 'guard allows an upstream sync that leaves discord byte-identical'
  fi

  printf 'vanilla\n' > "$TMP_ROOT/external_plugins/discord/server.ts"
  git -C "$TMP_ROOT" add external_plugins/discord/server.ts
  git -C "$TMP_ROOT" commit -qm discord-drift
  if (cd "$TMP_ROOT" && "$GUARD" "$BASE" HEAD); then
    fail 'guard rejects any discord tree delta before push'
  else
    pass 'guard rejects any discord tree delta before push'
  fi
fi

if [[ -x "$BUMP" ]]; then
  BUMP_ROOT="$(mktemp -d)"
  mkdir -p "$BUMP_ROOT/external_plugins/discord/.claude-plugin"
  printf '{"name":"discord","version":"0.0.4"}\n' \
    > "$BUMP_ROOT/external_plugins/discord/.claude-plugin/plugin.json"
  if (cd "$BUMP_ROOT" && "$BUMP") \
    && [[ "$(jq -r '.version' "$BUMP_ROOT/external_plugins/discord/.claude-plugin/plugin.json")" == "0.0.5" ]]; then
    pass 'version helper increments exactly the semver patch component'
  else
    fail 'version helper increments exactly the semver patch component'
  fi
  printf '{"name":"discord","version":"latest"}\n' \
    > "$BUMP_ROOT/external_plugins/discord/.claude-plugin/plugin.json"
  if (cd "$BUMP_ROOT" && "$BUMP") >/dev/null 2>&1; then
    fail 'version helper rejects a non-semver manifest'
  else
    pass 'version helper rejects a non-semver manifest'
  fi
  rm -rf "$BUMP_ROOT"
fi

if (( FAILURES > 0 )); then
  printf '%d test(s) failed\n' "$FAILURES" >&2
  exit 1
fi

printf 'all sync-upstream tests passed\n'
