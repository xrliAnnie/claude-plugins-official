/**
 * FLY-309 — INDEPENDENT QA adversarial suite for the FLY-306 reply retry guard.
 *
 * Written by the QA runner (NOT the author of retry.ts / reply-send.ts) to
 * probe the gaps the shipped 34-test suite leaves open. Maps each block to the
 * claim under test. Pure unit level — exercises the exact shipping source
 * (./retry, ./reply-send) with injected fakes, no live Discord.
 *
 * Highest-impact failure mode (Tadashi's #1): an already-delivered chunk must
 * NEVER be re-sent → no duplicate messages. Validated rigorously below across
 * several failure sequences.
 */

import { describe, it, expect } from 'bun:test'
import { RateLimitError } from '@discordjs/rest'
import {
  classifySendError,
  pickRetryAfterMs,
  computeBackoffMs,
  sendWithRetry,
  type SendWithRetryOpts,
} from './retry'
import { sendReplyChunks, type SendPayload } from './reply-send'

// Immediate-retry config (no real waiting).
const fastRetry = (maxRetries = 3): SendWithRetryOpts => ({
  maxRetries,
  baseMs: 1,
  capMs: 1,
  sleep: async () => {},
  jitterRand: () => 0,
})

// Build a real @discordjs/rest RateLimitError with overridable fields.
function realRateLimitError(over: Partial<{ timeToReset: number; retryAfter: number }>) {
  return new RateLimitError({
    timeToReset: 1000,
    limit: 5,
    method: 'POST',
    hash: 'h',
    url: 'https://discord.com/api/v10/channels/1/messages',
    route: '/channels/:id/messages',
    majorParameter: '1',
    global: false,
    retryAfter: 1000,
    sublimitTimeout: 0,
    scope: 'user',
    ...over,
  } as ConstructorParameters<typeof RateLimitError>[0])
}

// A recording fake channel: logs every send-call's content so we can prove
// idempotency at the wire level (a delivered chunk must not recur).
function recordingChannel(behaviour: (content: string, attempt: number) => 'ok' | unknown) {
  const calls: string[] = []
  const perChunkAttempts = new Map<string, number>()
  const send = async (p: SendPayload): Promise<{ id: string }> => {
    const c = p.content
    const n = (perChunkAttempts.get(c) ?? 0) + 1
    perChunkAttempts.set(c, n)
    calls.push(c)
    const r = behaviour(c, n)
    if (r !== 'ok') throw r
    return { id: c }
  }
  return { send, calls, attemptsFor: (c: string) => perChunkAttempts.get(c) ?? 0 }
}

const opts = { files: [] as string[], reply_to: undefined as string | undefined, replyMode: 'first' as const }

// ───────────────────────────────────────────────────────────────────────────
// Claim 3 (HIGHEST IMPACT): per-chunk idempotency — a DELIVERED chunk is NEVER
// re-sent, across multiple partial-failure sequences.
// ───────────────────────────────────────────────────────────────────────────
describe('QA claim-3 idempotency — delivered chunks never re-sent', () => {
  it('middle chunk (b) of 3 exhausts → a sent exactly once, c never attempted', async () => {
    const ch = recordingChannel((content, _n) => (content === 'b' ? { code: 'ETIMEDOUT' } : 'ok'))
    await expect(
      sendReplyChunks(ch.send, ['a', 'b', 'c'], opts, fastRetry(3)),
    ).rejects.toThrow(/delivering 1 of 3/)
    expect(ch.attemptsFor('a')).toBe(1) // delivered once, never re-sent
    expect(ch.attemptsFor('c')).toBe(0) // loop stopped at failed 'b' — never reached
    expect(ch.attemptsFor('b')).toBe(4) // 1 initial + 3 retries (at-least-once for the IN-FLIGHT chunk only)
    // 'a' must not appear again anywhere after the first call.
    expect(ch.calls.filter(c => c === 'a').length).toBe(1)
  })

  it('last chunk (c) of 3 exhausts → a and b each delivered exactly once', async () => {
    const ch = recordingChannel((content, _n) => (content === 'c' ? { status: 503 } : 'ok'))
    await expect(
      sendReplyChunks(ch.send, ['a', 'b', 'c'], opts, fastRetry(3)),
    ).rejects.toThrow(/delivering 2 of 3/)
    expect(ch.attemptsFor('a')).toBe(1)
    expect(ch.attemptsFor('b')).toBe(1)
    expect(ch.calls.filter(c => c === 'a').length).toBe(1)
    expect(ch.calls.filter(c => c === 'b').length).toBe(1)
  })

  it('b succeeds AFTER 2 transient retries, THEN c exhausts → a once, b once (no dup), c exhausts', async () => {
    // Tadashi's combined sequence: 块2成功(经重试)→块3失败重试.
    const ch = recordingChannel((content, n) => {
      if (content === 'b' && n < 3) return { code: 'ECONNRESET' } // succeeds on 3rd
      if (content === 'c') return { code: 'ETIMEDOUT' } // never succeeds
      return 'ok'
    })
    await expect(
      sendReplyChunks(ch.send, ['a', 'b', 'c'], opts, fastRetry(3)),
    ).rejects.toThrow(/delivering 2 of 3/)
    expect(ch.calls.filter(c => c === 'a').length).toBe(1) // never re-sent
    expect(ch.attemptsFor('b')).toBe(3) // 2 fails + 1 success — delivered ONCE
    // After 'b' succeeded the loop advanced; 'a'/'b' must not be re-issued during 'c' retries.
    const lastA = ch.calls.lastIndexOf('a')
    const lastB = ch.calls.lastIndexOf('b')
    const firstC = ch.calls.indexOf('c')
    expect(lastA).toBeLessThan(firstC)
    expect(lastB).toBeLessThan(firstC)
  })

  it('chunk a recovers (transient→success) then b exhausts → a delivered exactly once', async () => {
    const ch = recordingChannel((content, n) => {
      if (content === 'a' && n < 2) return { code: 'EAI_AGAIN' } // a recovers on 2nd
      if (content === 'b') return { code: 'ECONNREFUSED' } // exhausts
      return 'ok'
    })
    await expect(sendReplyChunks(ch.send, ['a', 'b'], opts, fastRetry(3))).rejects.toThrow(
      /delivering 1 of 2/,
    )
    expect(ch.attemptsFor('a')).toBe(2) // 1 fail + 1 success → ONE delivery, not duplicated by b's failure
  })

  it('all chunks succeed first try → each sent exactly once, ids in order', async () => {
    const ch = recordingChannel(() => 'ok')
    const ids = await sendReplyChunks(ch.send, ['a', 'b', 'c', 'd'], opts, fastRetry(3))
    expect(ids).toEqual(['a', 'b', 'c', 'd'])
    expect(ch.calls).toEqual(['a', 'b', 'c', 'd']) // zero retries on the happy path
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Claim 4: exhaustion → the dedup guidance tail is appended EXACTLY ONCE.
// ───────────────────────────────────────────────────────────────────────────
describe('QA claim-4 guidance tail — appended exactly once, never duplicated', () => {
  it('partial failure: "do NOT resend" guidance appears exactly once', async () => {
    const ch = recordingChannel((content, _n) => (content === 'b' ? { status: 500 } : 'ok'))
    let caught: Error | undefined
    try {
      await sendReplyChunks(ch.send, ['a', 'b', 'c'], opts, fastRetry(3))
    } catch (e) {
      caught = e as Error
    }
    expect(caught).toBeDefined()
    const msg = caught!.message
    expect((msg.match(/do NOT resend/g) ?? []).length).toBe(1)
    expect((msg.match(/delivering \d+ of \d+/g) ?? []).length).toBe(1) // not double-wrapped
    expect(msg).toMatch(/send only the remaining 2/)
  })

  it('zero delivered (first chunk exhausts) → NO guidance tail at all', async () => {
    const ch = recordingChannel(() => ({ code: 'ETIMEDOUT' }))
    let caught: Error | undefined
    try {
      await sendReplyChunks(ch.send, ['only', 'two'], opts, fastRetry(2))
    } catch (e) {
      caught = e as Error
    }
    expect(caught!.message).toMatch(/delivering 0 of 2/)
    expect(caught!.message).not.toMatch(/do NOT resend/)
    // exactly-once invariant still holds (it's just absent, count 0 ≤ 1).
    expect((caught!.message.match(/do NOT resend/g) ?? []).length).toBe(0)
  })

  it('guidance remaining-count matches the unsent tail (delivered 2 of 5 → remaining 3)', async () => {
    const ch = recordingChannel((content, _n) => (content === 'c' ? { status: 502 } : 'ok'))
    await expect(
      sendReplyChunks(ch.send, ['a', 'b', 'c', 'd', 'e'], opts, fastRetry(2)),
    ).rejects.toThrow(/delivering 2 of 5.*remaining 3/s)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Claim 5: DISCORD_REPLY_MAX_RETRIES=0 kill-switch — BEHAVIORAL (the shipped
// suite only asserts parseIntInRange('0')=0, never the runtime effect).
// ───────────────────────────────────────────────────────────────────────────
describe('QA claim-5 kill-switch — maxRetries:0 disables the retry loop', () => {
  it('sendWithRetry maxRetries:0 on a RETRYABLE error → fn called once, no sleep, original thrown', async () => {
    const delays: number[] = []
    let calls = 0
    const err = { code: 'ECONNRESET' } // would normally retry
    await expect(
      sendWithRetry(
        async () => {
          calls++
          throw err
        },
        { maxRetries: 0, baseMs: 500, capMs: 8000, sleep: async ms => { delays.push(ms) } },
      ),
    ).rejects.toBe(err)
    expect(calls).toBe(1) // reverted to fail-on-first
    expect(delays).toEqual([]) // never slept
  })

  it('sendReplyChunks with maxRetries:0 → transient on chunk 0 fails immediately (1 send call)', async () => {
    const ch = recordingChannel(() => ({ code: 'ETIMEDOUT' }))
    await expect(sendReplyChunks(ch.send, ['x', 'y'], opts, fastRetry(0))).rejects.toThrow(
      /delivering 0 of 2/,
    )
    expect(ch.attemptsFor('x')).toBe(1) // no retry
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Claim 6: non-transient errors are NOT retried (extra shapes).
// ───────────────────────────────────────────────────────────────────────────
describe('QA claim-6 non-transient — not retried', () => {
  it('404 / 401 / 400 / 403 → not retryable', () => {
    for (const status of [400, 401, 403, 404, 405, 422]) {
      expect(classifySendError({ status }).retryable).toBe(false)
    }
  })

  it('a plain Error (no shape) and unknown 4xx-ish names → not retryable, fails fast', async () => {
    let calls = 0
    await expect(
      sendWithRetry(
        async () => {
          calls++
          throw new Error('totally unknown')
        },
        fastRetry(3),
      ),
    ).rejects.toThrow('totally unknown')
    expect(calls).toBe(1)
  })

  it('a "RateLimiter"-ish name that does NOT start with RateLimitError is not a false positive', () => {
    // 'RateLimiterError' diverges at index 9 ('e' vs 'E') → must not match.
    expect(classifySendError({ name: 'RateLimiterError' }).retryable).toBe(false)
    expect(classifySendError({ name: 'NotARateLimitError' }).retryable).toBe(false)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Claim 1/2: repeated-transient-then-success at the retry boundary + Retry-After
// symmetry (both directions of max(timeToReset, retryAfter)).
// ───────────────────────────────────────────────────────────────────────────
describe('QA claim-1/2 — boundary retries + Retry-After symmetry', () => {
  it('succeeds on the VERY LAST allowed attempt (maxRetries transient fails, then ok)', async () => {
    const delays: number[] = []
    let calls = 0
    const out = await sendWithRetry(
      async () => {
        calls++
        if (calls <= 3) throw { code: 'ECONNRESET' } // 3 fails, succeed on 4th (== maxRetries+1)
        return 'sent'
      },
      { maxRetries: 3, baseMs: 500, capMs: 8000, jitterRand: () => 0, sleep: async ms => { delays.push(ms) } },
    )
    expect(out).toBe('sent')
    expect(calls).toBe(4)
    expect(delays).toEqual([500, 1000, 2000]) // exponential, attempts 0..2
  })

  it('one more transient than allowed → exhausts and throws original', async () => {
    let calls = 0
    const err = { code: 'EPIPE' }
    await expect(
      sendWithRetry(async () => { calls++; throw err }, fastRetry(2)),
    ).rejects.toBe(err)
    expect(calls).toBe(3) // 1 + 2 retries
  })

  it('Retry-After takes the LARGER field in BOTH directions', () => {
    expect(pickRetryAfterMs({ timeToReset: 1500, retryAfter: 2500 })).toBe(2500) // retryAfter larger
    expect(pickRetryAfterMs({ timeToReset: 3000, retryAfter: 1000 })).toBe(3000) // timeToReset larger
    // and via a REAL RateLimitError both ways
    expect(pickRetryAfterMs(realRateLimitError({ timeToReset: 4000, retryAfter: 100 }))).toBe(4000)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Robustness: malformed RateLimitError shapes must classify safely (retryable
// where appropriate) WITHOUT ever producing a negative/NaN sleep.
// ───────────────────────────────────────────────────────────────────────────
describe('QA robustness — malformed RateLimitError shapes never break backoff', () => {
  it('negative retry-after fields → retryable but retryAfterMs undefined (falls to exponential)', () => {
    const cls = classifySendError({ name: 'RateLimitError', timeToReset: -5, retryAfter: -10 })
    expect(cls.retryable).toBe(true)
    expect(cls.retryAfterMs).toBeUndefined()
  })

  it('NaN retry-after fields → retryAfterMs undefined', () => {
    expect(pickRetryAfterMs({ timeToReset: Number.NaN, retryAfter: Number.NaN })).toBeUndefined()
    const cls = classifySendError({ name: 'RateLimitError', timeToReset: Number.NaN })
    expect(cls.retryable).toBe(true)
    expect(cls.retryAfterMs).toBeUndefined()
  })

  it('Infinity retry-after → rejected (not finite) → undefined', () => {
    expect(pickRetryAfterMs({ retryAfter: Number.POSITIVE_INFINITY })).toBeUndefined()
  })

  it('string-typed retry-after ("5000") → rejected (duck-type guards number only)', () => {
    const cls = classifySendError({ status: 429, retryAfter: '5000' })
    expect(cls.retryable).toBe(true)
    expect(cls.retryAfterMs).toBeUndefined()
  })

  it('bare RateLimitError name with no wait fields → retryable, no retryAfterMs', () => {
    expect(classifySendError({ name: 'RateLimitError' })).toEqual({ retryable: true })
  })

  it('computeBackoffMs is clamped to >= 0 even if handed a negative retryAfterMs', () => {
    expect(computeBackoffMs(0, { baseMs: 500, capMs: 8000, retryAfterMs: -100 })).toBe(0)
    expect(computeBackoffMs(0, { baseMs: 500, capMs: 8000, retryAfterMs: 0 })).toBe(0)
  })

  it('computeBackoffMs never overflows the cap for an absurd attempt index', () => {
    expect(computeBackoffMs(1000, { baseMs: 500, capMs: 8000 })).toBe(8000)
  })

  it('a transient send that retries with a malformed RateLimitError still eventually succeeds', async () => {
    let calls = 0
    const out = await sendWithRetry(
      async () => {
        calls++
        if (calls === 1) throw { name: 'RateLimitError', timeToReset: -1, retryAfter: -1 } // garbage waits
        return 'ok'
      },
      fastRetry(3),
    )
    expect(out).toBe('ok')
    expect(calls).toBe(2)
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Documented edge: timeToReset:0 (bucket already reset) → retry immediately.
// This is CORRECT (server says wait 0), not a bug; pinned so it can't regress.
// ───────────────────────────────────────────────────────────────────────────
describe('QA edge — timeToReset:0 means retry-now (documented behaviour)', () => {
  it('pickRetryAfterMs({timeToReset:0}) is 0, not undefined', () => {
    expect(pickRetryAfterMs({ timeToReset: 0 })).toBe(0)
  })

  it('a 429 with timeToReset:0 retries with a 0ms delay (then succeeds)', async () => {
    const delays: number[] = []
    let calls = 0
    const out = await sendWithRetry(
      async () => {
        calls++
        if (calls === 1) throw { name: 'RateLimitError', timeToReset: 0 }
        return 'ok'
      },
      { maxRetries: 3, baseMs: 500, capMs: 8000, sleep: async ms => { delays.push(ms) } },
    )
    expect(out).toBe('ok')
    expect(delays).toEqual([0]) // honoured the server's 0-wait
  })
})

// ───────────────────────────────────────────────────────────────────────────
// Documented invariant: a throwing onSent must NOT make the failure report
// UNDER-count what actually went out (the chunk it fired for WAS delivered).
// ───────────────────────────────────────────────────────────────────────────
describe('QA invariant — throwing onSent never under-reports delivered count', () => {
  it('onSent throws on the 2nd chunk → error still counts it as delivered (2 of 3)', async () => {
    const ch = recordingChannel(() => 'ok') // every send SUCCEEDS at the wire
    let fired = 0
    await expect(
      sendReplyChunks(
        ch.send,
        ['a', 'b', 'c'],
        opts,
        fastRetry(3),
        (_id: string) => {
          fired++
          if (fired === 2) throw new Error('noteSent disk error')
        },
      ),
    ).rejects.toThrow(/delivering 2 of 3/) // 'b' was sent to Discord, so it's counted — never under-reported
    // both 'a' and 'b' physically went out exactly once; 'c' never attempted.
    expect(ch.calls).toEqual(['a', 'b'])
  })
})
