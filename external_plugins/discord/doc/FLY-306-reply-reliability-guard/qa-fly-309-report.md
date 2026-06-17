# QA Report: FLY-309 — Independent Validation of FLY-306 Reply Retry Guard

**Issue**: FLY-309 (QA: independent validation — FLY-306 Discord reply retry guard)
**Subject under test**: `xrliAnnie/claude-plugins-official` PR #6, branch `fix/FLY-306-reply-reliability-guard`, head `6723c72`
**QA runner**: runner-cfc20f16 (independent — did NOT author the implementation)
**Date**: 2026-06-17
**Verdict**: ✅ **PASS** — no bugs found. 3 non-blocking observations (none gate the merge).

---

## Method

1. Checked out the branch into an **isolated** worktree at the exact PR head (`6723c72`, verified == `gh pr view` headRefOid). Implementation never modified.
2. Ran the shipped **34 bun tests → 34/34 GREEN**; read every test critically.
3. **Typechecked** the changed files (`retry.ts`, `reply-send.ts`, `server.ts`) under strict `tsc` → clean (exit 0).
4. Traced the `server.ts` reply handler wiring + outer dispatch error surfacing (`server.ts:892` → `:974`).
5. Wrote **27 adversarial / edge tests** (`fly306-qa-adversarial.test.ts`) for the gaps → **27/27 GREEN** (combined suite 61/61, 157 assertions).
6. **Mutation check** (test-teeth proof): injected the exact anti-pattern the design forbids (whole-batch retry instead of per-chunk) → the 4 idempotency tests **failed as expected**; reverted → 61/61 green again.

## Claims — validated

| # | Claim | Verdict | Evidence |
|---|-------|---------|----------|
| 1 | Transient failures retried w/ bounded backoff | ✅ | `sendWithRetry` retries ECONNRESET/5xx/429; exponential backoff capped at `capMs`; boundary test (succeeds on last allowed attempt; one-more-than-allowed exhausts) |
| 2 | Retry-After honored = `max(timeToReset, retryAfter)` | ✅ | `pickRetryAfterMs` larger-of in **both** directions, incl. real `RateLimitError`; sublimit divergence (`timeToReset:0, retryAfter:5000`→5000) |
| 3 | **Per-chunk idempotency — delivered chunk NEVER re-sent** | ✅ | 4 partial-failure sequences (mid-chunk exhausts, last-chunk exhausts, transient-then-success-then-later-exhaust, chunk-0 recovers then later exhausts) — delivered chunks each show `attempts == 1`, later chunks never reached. **Teeth proven by mutation.** |
| 4 | Exhaustion → dedup guidance tail, appended **once** | ✅ | `do NOT resend` substring count == 1; `delivering N of M` count == 1 (no double-wrap); remaining-count matches unsent tail; absent when 0 delivered |
| 5 | `DISCORD_REPLY_MAX_RETRIES=0` kill-switch | ✅ | **Behavioral** test (the shipped suite only checked the parse): `maxRetries:0` on a retryable error → fn called exactly once, zero sleeps, original error thrown |
| 6 | Non-transient errors NOT retried | ✅ | 400/401/403/404/405/422 + plain `Error` + unknown shapes → not retryable, fail-fast (1 call); `RateLimiterError` is not a false-positive of the `RateLimitError` name-prefix match |

## Robustness (malformed shapes) — all safe

Negative / `NaN` / `Infinity` / string-typed `retryAfter`/`timeToReset` → classified retryable where appropriate but `retryAfterMs` undefined, so backoff falls to exponential — **never a negative or NaN sleep**. `computeBackoffMs` clamps `>= 0` and never overflows the cap even at absurd attempt indices.

## Observations (non-blocking — NOT bugs)

1. **Kill-switch is a retry-behavior revert, not a byte-for-byte message revert.** With `=0` the retry loop is disabled (verified), but the error text is the new format incl. the dedup guidance. This is arguably an improvement (model still steered off a full resend). Claim 5's stated purpose (disable retries) holds.
2. **`timeToReset:0` → 0 ms-delay retry.** Correct per server semantics (bucket already reset = retry now); pinned by a test. A pathological 429 carrying `timeToReset:0` could do up to `maxRetries` immediate sends, but discord.js handles 429s internally and an escaped 429 with a 0-wait is contradictory. Low/no severity.
3. **Cosmetic double "reply failed" prefix.** Inner `sendReplyChunks` throws `reply failed after delivering …`; the outer dispatch catch (`server.ts:977`) prepends `reply failed: ` → model sees `reply failed: reply failed after delivering …`. Purely cosmetic, no functional impact.

## Known accepted limitation (per the PR's own honest declaration)

Single in-flight chunk retry is **at-least-once**: if Discord accepted a send but the response was lost (e.g. ECONNRESET), the retry duplicates **that one chunk**. Discord's message API has no idempotency key, so exactly-once is impossible at this layer. The trade (rare visible duplicate ≫ silent message loss) is documented and matches discord.js's own network-retry semantics. Not a QA failure.

## Artifacts

- `external_plugins/discord/fly306-qa-adversarial.test.ts` — 27 independent adversarial tests.
- Baseline: `bun test` in `external_plugins/discord` → **61 pass / 0 fail / 157 expect()**.
