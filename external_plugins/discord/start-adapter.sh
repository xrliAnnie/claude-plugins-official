#!/usr/bin/env bash
# FLY-183: Discord channel adapter launcher.
#
# Why this exists: previously .mcp.json launched `bun run --cwd <plugin> start`,
# whose package script (`bun install && bun server.ts`) spawned the real adapter
# (`bun server.ts`) as a CHILD of the `bun run` wrapper. On Claude death the
# wrapper could die while the inner adapter survived, reparented to launchd, and
# kept holding the bot-token Discord gateway connection -> orphan leak (FLY-183).
#
# By `exec`ing into `bun server.ts`, this launcher REPLACES itself, so the adapter
# becomes a DIRECT child of Claude. Two payoffs:
#   1. on Claude death the adapter's ppid becomes 1 -> server.ts's ppid watch can
#      reliably self-terminate (no surviving wrapper to mask the parent death);
#   2. the adapter's argv is `bun <abs>/server.ts` (absolute, contains the plugin
#      path), so the supervisor-side reaper can match it directly.
set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

# The MCP spawn environment may not have bun on PATH; fall back to known install
# locations (matches the launchd/tmux PATH handling in claude-lead.sh).
command -v bun >/dev/null 2>&1 || export PATH="$HOME/.bun/bin:$HOME/.npm-global/bin:$PATH"

# Hard fail if bun is still unresolvable — there is no point continuing to a
# `bun install` / `exec bun` that would fail with a less direct error.
if ! command -v bun >/dev/null 2>&1; then
  echo "discord channel: bun not found on PATH — aborting (FLY-183)" >&2
  exit 127
fi

# Install deps (first run / version bumps). Do not silently swallow failures:
# tolerate an install error ONLY when deps are already present (offline), else
# fail loudly rather than exec a server that will crash with a less direct error.
if ! bun install --no-summary; then
  if [ -d "$DIR/node_modules/discord.js" ]; then
    echo "discord channel: bun install failed, using existing node_modules (FLY-183)" >&2
  else
    echo "discord channel: bun install failed and node_modules missing — aborting (FLY-183)" >&2
    exit 1
  fi
fi

exec bun "$DIR/server.ts"
