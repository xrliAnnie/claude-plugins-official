# FLY-1437 — Durable inbound chat receipt producer

This fork records every Discord message that passes the plugin access gate when
the Flywheel receipt capability tuple is present:

1. `chat-receipt begin` runs before typing, reactions, or MCP delivery.
2. The MCP notification carries `receipt_id=chat:<lead_id>:<message_id>`.
3. `chat-receipt complete` runs only after that notification resolves.
4. A successfully returned Discord message whose persisted
   `reference.messageId=<message_id>` runs `chat-receipt settle`.

The producer is idempotent because the PR-1 CLI owns the stable receipt id.
Roundtable cross-channel reference stripping, `replyToMode=off`, and failed
sends do not settle a receipt; the Lead uses `handle-receipt ack` after the
real handling side effect in those cases.

## Recovery

`begin` failures remain fail-open for chat delivery and atomically spool a
0600 intent under a 0700
`$DISCORD_STATE_DIR/chat-receipt-spool/` directory. A single-flight,
event-driven worker runs on Discord ready and after each accept:

- retries at most 5 spool intents per pass;
- persists failed settlement proofs under `chat-receipt-spool/settle/` and
  retries them after transient CLI failures or process restarts;
- scans at most 100 undelivered `chat:` rows per pass in pages of 20;
- skips message ids still inside the live accept boundary;
- quarantines rows older than 48 hours before redelivery;
- awaits redelivery before `complete`;
- continues finite backlogs while real progress is made, without a periodic
  timer or a zero-progress hot loop.

Corrupt intents are preserved as `.corrupt`. Retry, depth, corruption, and
broken-wiring advisories use durable detected/sent markers; an advisory is
latched only after its Discord send succeeds.

## Enablement matrix

- Full `FLYWHEEL_COMM_CLI` + `FLYWHEEL_COMM_DB` + `FLYWHEEL_LEAD_ID`: enabled.
- Stock install with all three absent: disabled, byte-compatible.
- `FLYWHEEL_LEAD_COMPANION=1` or `FLYWHEEL_LEAD_EXTERNAL=1`: intentionally
  disabled with no warning.
- `FLYWHEEL_CHAT_RECEIPTS=0`: disabled kill switch.
- Any other partial tuple: fail-open delivery plus a durable visible warning.

Founder priority resolves `DISCORD_OWNER_USER_ID` from the live
`~/.flywheel/.env` before inherited process environment. If it is unavailable,
receipts use P1 and startup logs the downgrade.

## Verification

From this directory:

```sh
FLYWHEEL_COMM_CLI=/absolute/path/to/flywheel-comm/dist/index.js bun test
bun build server.ts --target=bun --outfile=/tmp/discord-server.js
```

The runtime integration test invokes the real built PR-1 CLI and a temporary
comm.db to prove idempotent begin, delivered completion, and
`processed_at`/`discord_explicit_reply` settlement.

## Deployment and rollback

Merging this fork is not enough to change a running Lead. Deploy with
`~/.flywheel/bin/update-discord-plugin.sh`, then restart each Lead session so
Claude Code spawns the updated Discord MCP process.

Roll out one Lead at a time:

1. Preflight
   `node "$FLYWHEEL_COMM_CLI" chat-receipt pending --lead <lead-id> --json`.
2. Restart the Lead session.
3. Verify one real message reaches delivered and then processed state.
4. Continue the rolling restart only after the single-Lead check passes.

For a zero-code rollback, set `FLYWHEEL_CHAT_RECEIPTS=0` in
`~/.flywheel/.env` and restart affected Lead sessions. A fork revert plus
plugin update and Lead restart is the code rollback.
