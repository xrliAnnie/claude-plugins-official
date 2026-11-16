# Inbound catch-up after a gateway gap (FLY-5394)

The Discord gateway does not replay events to a **new** session. Whenever this
plugin restarts, or reconnects without resuming, messages sent to the Lead in
the gap were never delivered. Inbound catch-up closes that gap for
Flywheel-managed Leads (`RECORDER_MODE` enabled or broken). Stock and isolated
(companion / external) plugins are unchanged: no state file, no requests.

## How it works

1. A **catch-up window** is opened and written to disk the moment a gap may
   begin: at module load (before `client.login`), at the first
   `shardReconnecting` / `shardDisconnect` / `invalidated` of a disconnect, and
   when one message cannot be durably recorded.
2. After every `shardReady` / `shardResume` (enabled mode only) one run reads
   history after each channel's last processed message id, from the identity
   channels in `access.json`, their active threads, public threads archived
   inside the window, raw `THREAD_*` packets seen while a window is open, and
   every thread that sent this Lead a message in the last 7 days (read by id).
3. Each message goes through the same intake chain as live delivery (self-bot
   filter, system / bot allowlist, `gate`, mailbox). The mailbox delivery id
   `chat:<lead>:<messageId>` keeps every message registered once; in-process,
   live and catch-up meeting the same id run once.
4. A window is closed only by a run that claimed it and fully succeeded. A run
   that saw a disconnect, a failed intake, an incomplete listing, or shutdown
   closes nothing.

## State

`${DISCORD_STATE_DIR}/inbound-catchup.json` (0600, atomic replace):

| Field | Meaning |
|---|---|
| `liveThroughMs` | Messages received before this moment are durably processed. |
| `windows` | Open catch-up windows (`seq`, `floorMs`, `cause`). |
| `cursors` | Channel / thread id → last processed message id. While a window is open a channel's cursor only advances with catch-up progress. |
| `heard` | Thread id → when this Lead last received a message there (kept 8 days). |
| `heardBootstrap` | One-time initialization of `heard` on the first upgrade (`pending` until it fully succeeds). |

Without any evidence (no state file and no previous `gateway-status.json`
heartbeat) only the last 15 minutes are read.

## Logs

Lines are appended to `gateway-health.log` with the prefix `inbound-catchup`:
`window_open`, `window_close`, `start`, `done`, `incomplete reason=…`,
`heard_bootstrap`, `heard_capped`, `state_invalid`, `state_write_failed`,
`skipped_forbidden`, `skipped_missing`, `skipped_kind`, `page_not_forward`,
`windows_merged`. No message content or token is logged.

## Rollback

Revert the change and bump the plugin version; each Lead picks it up on its
next start. The old code ignores `inbound-catchup.json`. If the feature is
re-enabled later, windows still open in that file are caught up again (the
mailbox deduplicates; only extra reads happen). To avoid that, delete the file
while the Lead is stopped.
