import { describe, it, expect } from 'bun:test'
import { RateLimitError } from '@discordjs/rest'
import {
  classifySendError,
  pickRetryAfterMs,
  computeBackoffMs,
  sendWithRetry,
  parseIntInRange,
} from './retry'

describe('classifySendError', () => {
  it('treats a discord.js RateLimitError as retryable and extracts the wait', () => {
    const err = { name: 'RateLimitError', timeToReset: 1234 }
    expect(classifySendError(err)).toEqual({ retryable: true, retryAfterMs: 1234 })
  })

  it('treats a REAL @discordjs/rest RateLimitError as retryable (name carries the route, status is undefined)', () => {
    // @discordjs/rest names this `RateLimitError[/channels/:id/messages]`, not
    // the bare 'RateLimitError', and it has no HTTP `status` — a substring/exact
    // name check would miss it and drop the message. This is the FLY-306 R1 bug.
    const err = new RateLimitError({
      timeToReset: 1234,
      limit: 5,
      method: 'POST',
      hash: 'abc',
      url: 'https://discord.com/api/v10/channels/1/messages',
      route: '/channels/:id/messages',
      majorParameter: '1',
      global: false,
      retryAfter: 1234,
      sublimitTimeout: 0,
      scope: 'user',
    } as ConstructorParameters<typeof RateLimitError>[0])
    expect(err.name.startsWith('RateLimitError')).toBe(true)
    const cls = classifySendError(err)
    expect(cls.retryable).toBe(true)
    expect(cls.retryAfterMs).toBe(1234)
  })

  it('treats a routed RateLimitError name string as retryable', () => {
    expect(
      classifySendError({ name: 'RateLimitError[/channels/:id/messages]', timeToReset: 900 }),
    ).toEqual({ retryable: true, retryAfterMs: 900 })
  })

  it('treats HTTP 429 as retryable', () => {
    expect(classifySendError({ status: 429, retryAfter: 2000 })).toEqual({
      retryable: true,
      retryAfterMs: 2000,
    })
  })

  it('treats 5xx as retryable (no retry-after)', () => {
    expect(classifySendError({ status: 503 })).toEqual({ retryable: true })
    expect(classifySendError({ status: 500 })).toEqual({ retryable: true })
  })

  it('treats 4xx (non-429) as permanent — do not retry', () => {
    // 403 missing-permissions (Discord code 50013), 400 invalid form body
    expect(classifySendError({ status: 403, code: 50013 }).retryable).toBe(false)
    expect(classifySendError({ status: 400, code: 50035 }).retryable).toBe(false)
  })

  it('treats network / timeout errors as retryable (incl. cause.code and undici codes)', () => {
    for (const code of [
      'ECONNRESET',
      'ETIMEDOUT',
      'ENOTFOUND',
      'EAI_AGAIN',
      'EPIPE',
      'ECONNREFUSED',
      'ECONNABORTED',
      'UND_ERR_CONNECT_TIMEOUT',
      'UND_ERR_SOCKET',
    ]) {
      expect(classifySendError({ code }).retryable).toBe(true)
    }
    expect(classifySendError({ name: 'AbortError' }).retryable).toBe(true)
    // undici wraps the root cause one level down
    expect(
      classifySendError({ name: 'TypeError', message: 'fetch failed', cause: { code: 'ECONNRESET' } })
        .retryable,
    ).toBe(true)
  })

  it('treats unknown / malformed errors as NOT retryable (avoid duplicate sends)', () => {
    expect(classifySendError(new Error('boom')).retryable).toBe(false)
    expect(classifySendError({ status: 418 }).retryable).toBe(false)
    expect(classifySendError(null).retryable).toBe(false)
    expect(classifySendError(undefined).retryable).toBe(false)
    expect(classifySendError('nope').retryable).toBe(false)
  })
})

describe('pickRetryAfterMs', () => {
  it('uses either field, and takes the larger when both are present', () => {
    expect(pickRetryAfterMs({ timeToReset: 1500 })).toBe(1500)
    expect(pickRetryAfterMs({ retryAfter: 2500 })).toBe(2500)
    expect(pickRetryAfterMs({ timeToReset: 1500, retryAfter: 2500 })).toBe(2500)
  })

  it('honours retryAfter when timeToReset is 0 (sublimit divergence — never retry-now)', () => {
    // @discordjs/rest can carry timeToReset:0 with a positive retryAfter; a
    // "prefer timeToReset" would sleep 0ms and violate the server wait.
    expect(pickRetryAfterMs({ timeToReset: 0, retryAfter: 5000 })).toBe(5000)
    const err = new RateLimitError({
      timeToReset: 0,
      limit: 5,
      method: 'POST',
      hash: 'h',
      url: 'https://discord.com/api/v10/channels/1/messages',
      route: '/channels/:id/messages',
      majorParameter: '1',
      global: false,
      retryAfter: 5000,
      sublimitTimeout: 5000,
      scope: 'user',
    } as ConstructorParameters<typeof RateLimitError>[0])
    expect(pickRetryAfterMs(err)).toBe(5000)
    expect(classifySendError(err)).toEqual({ retryable: true, retryAfterMs: 5000 })
  })

  it('returns undefined when absent or non-finite/negative', () => {
    expect(pickRetryAfterMs({})).toBeUndefined()
    expect(pickRetryAfterMs({ timeToReset: -1 })).toBeUndefined()
    expect(pickRetryAfterMs({ retryAfter: Number.NaN })).toBeUndefined()
    expect(pickRetryAfterMs(null)).toBeUndefined()
  })
})

describe('parseIntInRange', () => {
  it('parses a valid in-range integer', () => {
    expect(parseIntInRange('3', 9, 0, 10)).toBe(3)
    expect(parseIntInRange('0', 9, 0, 10)).toBe(0)
  })

  it('falls back when missing', () => {
    expect(parseIntInRange(undefined, 9, 0, 10)).toBe(9)
  })

  it('rejects malformed / non-strict-integer strings (falls back)', () => {
    expect(parseIntInRange('3abc', 9, 0, 10)).toBe(9) // parseInt would have accepted as 3
    expect(parseIntInRange('3.9', 9, 0, 10)).toBe(9) // not an integer
    expect(parseIntInRange('', 9, 0, 10)).toBe(9)
    expect(parseIntInRange('  ', 9, 0, 10)).toBe(9)
    expect(parseIntInRange('abc', 9, 0, 10)).toBe(9)
  })

  it('rejects out-of-range values (falls back)', () => {
    expect(parseIntInRange('-1', 9, 0, 10)).toBe(9)
    expect(parseIntInRange('11', 9, 0, 10)).toBe(9)
  })

  it('accepts surrounding whitespace around a valid integer', () => {
    expect(parseIntInRange(' 4 ', 9, 0, 10)).toBe(4)
  })
})

describe('computeBackoffMs', () => {
  const opts = { baseMs: 500, capMs: 8000, jitterRand: () => 0 }

  it('honours retry-after, capped', () => {
    expect(computeBackoffMs(0, { ...opts, retryAfterMs: 5000 })).toBe(5000)
    expect(computeBackoffMs(0, { ...opts, retryAfterMs: 20000 })).toBe(8000) // capped
  })

  it('grows exponentially and is capped', () => {
    expect(computeBackoffMs(0, opts)).toBe(500)
    expect(computeBackoffMs(1, opts)).toBe(1000)
    expect(computeBackoffMs(2, opts)).toBe(2000)
    expect(computeBackoffMs(4, opts)).toBe(8000) // 500*16 = 8000
    expect(computeBackoffMs(5, opts)).toBe(8000) // 500*32 capped
  })

  it('adds bounded jitter from the injected rng, never exceeding cap', () => {
    expect(computeBackoffMs(0, { ...opts, jitterRand: () => 0.5 })).toBe(750) // 500 + 0.5*500
    expect(computeBackoffMs(5, { ...opts, jitterRand: () => 1 })).toBe(8000) // capped even with jitter
  })
})

describe('sendWithRetry', () => {
  const fakeSleepFactory = () => {
    const delays: number[] = []
    return { delays, sleep: async (ms: number) => { delays.push(ms) } }
  }
  const base = { maxRetries: 3, baseMs: 500, capMs: 8000, jitterRand: () => 0 }

  it('returns immediately on first success — no sleeps', async () => {
    const { delays, sleep } = fakeSleepFactory()
    let calls = 0
    const out = await sendWithRetry(async () => { calls++; return 'ok' }, { ...base, sleep })
    expect(out).toBe('ok')
    expect(calls).toBe(1)
    expect(delays).toEqual([])
  })

  it('retries transient failures then succeeds', async () => {
    const { delays, sleep } = fakeSleepFactory()
    let calls = 0
    const out = await sendWithRetry(async () => {
      calls++
      if (calls < 3) throw { code: 'ECONNRESET' }
      return 'sent'
    }, { ...base, sleep })
    expect(out).toBe('sent')
    expect(calls).toBe(3)
    expect(delays).toEqual([500, 1000]) // backoff for attempt 0 and 1
  })

  it('gives up after maxRetries and throws the original error', async () => {
    const { delays, sleep } = fakeSleepFactory()
    let calls = 0
    const err = { code: 'ETIMEDOUT' }
    await expect(
      sendWithRetry(async () => { calls++; throw err }, { ...base, sleep }),
    ).rejects.toBe(err)
    expect(calls).toBe(4) // 1 initial + 3 retries
    expect(delays.length).toBe(3)
  })

  it('does NOT retry permanent errors — throws immediately', async () => {
    const { delays, sleep } = fakeSleepFactory()
    let calls = 0
    const err = { status: 403, code: 50013 }
    await expect(
      sendWithRetry(async () => { calls++; throw err }, { ...base, sleep }),
    ).rejects.toBe(err)
    expect(calls).toBe(1)
    expect(delays).toEqual([])
  })

  it('respects Retry-After from a rate-limit error', async () => {
    const { delays, sleep } = fakeSleepFactory()
    let calls = 0
    const out = await sendWithRetry(async () => {
      calls++
      if (calls === 1) throw { name: 'RateLimitError', timeToReset: 1234 }
      return 'sent'
    }, { ...base, sleep })
    expect(out).toBe('sent')
    expect(delays).toEqual([1234])
  })

  it('reports each retry via onRetry', async () => {
    const { sleep } = fakeSleepFactory()
    const seen: number[] = []
    let calls = 0
    await sendWithRetry(async () => {
      calls++
      if (calls < 2) throw { code: 'ECONNRESET' }
      return 'sent'
    }, { ...base, sleep, onRetry: info => seen.push(info.attempt) })
    expect(seen).toEqual([0])
  })
})
