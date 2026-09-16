# FLY-2598 voice self-author admission

Voice uses the owning Lead's Discord bot. Every `messageCreate` callback now
passes the same pure self-author guard before allowBots, routing, receipts,
reactions or legacy notification delivery. The first ready identity is pinned;
unknown identity, disconnect and a changed identity fail closed. A changed
identity requires a fresh carrier process, not rebinding the existing guard.

When the recorder is enabled, this carrier binds `voice-self-filter.sock` under
its existing `DISCORD_STATE_DIR`. It answers one read-only newline-delimited
JSON request, capped at 4KiB and two seconds. Requests use HMAC-SHA256 with the
Lead bot token over `[1,"voice-self-filter-v1",leadId,expectedBotUserId,nonce]`.
The random 32-byte hex nonce is echoed in a signed response containing the
process runtime UUID and the actual guard's self/unknown/other results. A source
file, capability flag or old receipt does not constitute a live proof.

The socket is mode 0600. Existing paths (including symlinks and unproven stale
sockets) are never taken over. Bind failure keeps ordinary messaging running but
voice admission unavailable. Shutdown only removes the bound socket identity;
it preserves replacement paths. No Discord REST requests or mailbox writes occur
inside the probe.

This change does not install or reload any production plugin. Deployment must
record this fork's exact commit, carrier incarnation and live runtime proof,
alongside the main FLY-2598 Bridge deployment. End active voice sessions before
carrier deployment or rollback. A missing probe remains an admission failure.

Verification: `bun install --frozen-lockfile && bun test` in this directory.
Tests exercise the registered callback, reconnect/unknown identity, a mutated
guard, live authenticated sockets, limits, ownership and a Node client talking
to the Bun server. Real room audio and managed loading remain separate checks.
