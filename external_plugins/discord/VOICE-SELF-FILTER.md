# FLY-2598 voice self-author admission

Voice uses the owning Lead's Discord bot. Every `messageCreate` callback now
passes the same pure self-author guard before allowBots, routing, receipts,
reactions or legacy notification delivery. The first ready identity is pinned;
the pinned identity—not gateway connection state—controls inbound filtering, so
Discord resume replay does not discard founder messages. The live probe still
requires the pinned identity, current `client.user`, ready gateway, and enabled
recorder to agree. A changed identity fails closed and requires a fresh carrier
process; a disconnect only closes voice admission until the gateway is ready.

When the recorder is enabled, this carrier binds `voice-self-filter.sock` under
its existing `DISCORD_STATE_DIR`. It answers one read-only newline-delimited
JSON request, capped at 4KiB and two seconds. Requests use HMAC-SHA256 with the
Lead bot token over `[1,"voice-self-filter-v1",leadId,expectedBotUserId,nonce]`.
The random 32-byte hex nonce is echoed in a signed response containing the
process runtime UUID and the actual guard's self/unknown/other results. A source
file, capability flag or old receipt does not constitute a live proof.

The socket is mode 0600. A macOS `O_EXLOCK` lock held for the socket lifetime is
the only ownership proof. The lock file is never deleted. Its holder may reclaim
same-uid socket names left by a dead predecessor before binding a private unique
name and publishing the public hard link. A live owner keeps the lock, while a
symlink, non-socket, foreign-owner path, or unsafe lock stays untouched and keeps
voice admission closed. Shutdown removes only the holder's inode-linked names,
closes the server, and releases the lock last. A 30-second ownership check
rebinds after external deletion or replacement. No Discord REST requests or
mailbox writes occur inside the probe.

This change does not install or reload any production plugin. Deployment must
record this fork's exact commit, carrier incarnation and live runtime proof,
alongside the main FLY-2598 Bridge deployment. End active voice sessions before
carrier deployment or rollback. Rolling back below plugin 0.0.8 intentionally
returns Claude-carrier voice admission to fail-closed 503 behavior; ordinary
text intake returns to the older plugin behavior. A missing probe remains an
admission failure.

Verification: `bun install --frozen-lockfile && bun test` in this directory.
Tests exercise the registered callback, resume replay, a mutated guard, live
authenticated sockets, kernel-lock crash recovery and handoff, limits, ownership,
and a Node client talking to the Bun server. Real room audio and managed loading
remain separate checks.

## Probe deadline and rejection frame (FLY-3436)

The socket keeps a probe connection open for up to 30 seconds from accept, the
largest legal Bridge probe budget, so the Lead never hangs up before the
Bridge's own timeout (this constant mirrors the flywheel contract and must stay
equal to it). Requests that fail validation or authentication get one fixed
`{"ok":false,"error":"self_filter_invalid_request"}` frame instead of a silent
close: the Bridge reads that as a terminal rejection, while a zero-byte close is
treated as a recoverable drop. Oversized input is still destroyed immediately.
