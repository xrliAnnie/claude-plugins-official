/**
 * FLY-306: bounded retry guard for outbound Discord sends.
 *
 * The `reply` tool used to fail a chunk send on the first thrown error, so a
 * transient hiccup (network blip, 5xx, a 429 that escaped discord.js's own
 * internal handling) silently dropped the message — the Lead believed it had
 * replied while the user saw nothing. This module is the outer safety net:
 * discord.js v14 already auto-waits on normal 429s and retries network/5xx a
 * few times internally; this only kicks in for what it surfaces as a thrown
 * error.
 *
 * Pure, dependency-free, and side-effect-free (sleep / rng are injected) so the
 * classification + backoff logic is unit-testable without a live Discord
 * connection. Errors are classified by structural shape (status/code/name/
 * cause), NOT `instanceof` — under bun + dual-package layouts an `instanceof`
 * check against discord.js's error classes is unreliable across module
 * instances.
 */

export interface SendErrorClass {
  retryable: boolean
  /** Honour-the-server wait, in ms, when the error carries one. */
  retryAfterMs?: number
}

/** Network / transport error codes that are safe to retry (a fresh send). */
const TRANSIENT_NET_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
  'ECONNREFUSED',
  'ECONNABORTED',
])

function finitePositive(n: unknown): number | undefined {
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : undefined
}

/**
 * Extract a server-advised wait (ms). @discordjs/rest's RateLimitError carries
 * both `retryAfter` (time until THIS request may retry) and `timeToReset` (route
 * bucket reset); in sublimit cases they diverge (e.g. timeToReset 0 while
 * retryAfter is positive). Take the larger of the present positive values so we
 * never retry earlier than either says — a plain "prefer one" would honour a
 * zero on the other field and retry immediately. Returns undefined when neither
 * is a finite positive number.
 */
export function pickRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const e = err as Record<string, unknown>
  const a = finitePositive(e.timeToReset)
  const b = finitePositive(e.retryAfter)
  if (a === undefined && b === undefined) return undefined
  return Math.max(a ?? 0, b ?? 0)
}

export function classifySendError(err: unknown): SendErrorClass {
  if (!err || typeof err !== 'object') return { retryable: false }
  const e = err as Record<string, unknown>
  const retryAfterMs = pickRetryAfterMs(e)

  // Explicit rate limit. discord.js normally swallows these internally; if one
  // reaches us (global limit / cloudflare) it is retryable, and we honour the
  // advertised wait. @discordjs/rest names its RateLimitError with the route
  // appended (e.g. `RateLimitError[/channels/:id/messages]`) and exposes no
  // HTTP `status`, so match by name prefix, not equality.
  const status = typeof e.status === 'number' ? e.status : undefined
  if ((typeof e.name === 'string' && e.name.startsWith('RateLimitError')) || status === 429) {
    return { retryable: true, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
  }

  // Server-side transient.
  if (status !== undefined && status >= 500 && status <= 599) {
    return { retryable: true, ...(retryAfterMs !== undefined ? { retryAfterMs } : {}) }
  }

  // Any other HTTP 4xx (missing perms, invalid body, not found, ...) is a
  // permanent client error — retrying just re-fails and would mask the bug.
  if (status !== undefined && status >= 400 && status < 500) {
    return { retryable: false }
  }

  // Network / timeout errors carry no HTTP status. discord.js / undici surface
  // a `code`, sometimes one level down under `cause`.
  if (e.name === 'AbortError') return { retryable: true }
  const code = (typeof e.code === 'string' ? e.code : undefined)
    ?? (e.cause && typeof e.cause === 'object'
      ? (typeof (e.cause as Record<string, unknown>).code === 'string'
          ? ((e.cause as Record<string, unknown>).code as string)
          : undefined)
      : undefined)
  if (code && (TRANSIENT_NET_CODES.has(code) || code.startsWith('UND_ERR'))) {
    return { retryable: true }
  }

  // Unknown — be conservative. A send that may have partly succeeded must not
  // be retried blindly (would duplicate the message); surface it loudly.
  return { retryable: false }
}

export interface BackoffOpts {
  baseMs: number
  capMs: number
  retryAfterMs?: number
  /** Injected RNG in [0,1) for jitter; defaults to no jitter when omitted. */
  jitterRand?: () => number
}

/**
 * Delay before the next attempt. `attempt` is 0-indexed (0 = first retry).
 * Honours a server retry-after when present (capped); otherwise exponential
 * backoff with bounded jitter. Never exceeds capMs.
 */
export function computeBackoffMs(attempt: number, opts: BackoffOpts): number {
  const { baseMs, capMs, retryAfterMs, jitterRand } = opts
  if (retryAfterMs !== undefined) {
    return Math.min(capMs, Math.max(0, Math.round(retryAfterMs)))
  }
  const exp = Math.min(capMs, baseMs * 2 ** attempt)
  const jitter = (jitterRand ? jitterRand() : 0) * baseMs
  return Math.min(capMs, Math.round(exp + jitter))
}

export interface SendWithRetryOpts {
  maxRetries: number
  baseMs: number
  capMs: number
  sleep: (ms: number) => Promise<void>
  jitterRand?: () => number
  onRetry?: (info: { attempt: number; delayMs: number; err: unknown }) => void
}

/**
 * Run `fn` with bounded retry on transient failures. Re-throws the original
 * error on a permanent failure or once retries are exhausted, preserving the
 * underlying error for the caller's surfacing. `fn` is invoked at most
 * `maxRetries + 1` times.
 */
export async function sendWithRetry<T>(
  fn: () => Promise<T>,
  opts: SendWithRetryOpts,
): Promise<T> {
  const { maxRetries, baseMs, capMs, sleep, jitterRand, onRetry } = opts
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (err) {
      const { retryable, retryAfterMs } = classifySendError(err)
      if (!retryable || attempt >= maxRetries) throw err
      const delayMs = computeBackoffMs(attempt, { baseMs, capMs, retryAfterMs, jitterRand })
      onRetry?.({ attempt, delayMs, err })
      await sleep(delayMs)
    }
  }
}

/**
 * Parse a config env value as a strict integer within [min, max], falling back
 * to `fallback` on missing / malformed / out-of-range input. Strict: unlike
 * Number.parseInt, "3abc" and "3.9" are rejected (not silently truncated).
 */
export function parseIntInRange(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (raw === undefined) return fallback
  const trimmed = raw.trim()
  if (!/^[+-]?\d+$/.test(trimmed)) return fallback
  const n = Number(trimmed)
  if (!Number.isInteger(n) || n < min || n > max) return fallback
  return n
}
