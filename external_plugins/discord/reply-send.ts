/**
 * FLY-306: the reply tool's chunk-send loop, extracted so the
 * silent-loss / no-duplicate behaviour can be unit-tested without standing up
 * the whole MCP server + a live Discord client. server.ts wires the real
 * `ch.send` into `send` and `noteSent` into `onSent`.
 */

import { sendWithRetry, type SendWithRetryOpts } from './retry'

/** The subset of discord.js MessageCreateOptions the reply tool builds. */
export interface SendPayload {
  content: string
  files?: string[]
  reply?: { messageReference: string; failIfNotExists: boolean }
}

export interface ReplyChunkOpts {
  files: string[]
  reply_to?: string
  replyMode: 'off' | 'first' | 'all'
}

/**
 * Build the per-chunk send payload. Files ride on the first chunk only; the
 * quote-reply reference is applied per `replyMode` (first chunk / all / never).
 * Pure.
 */
export function buildChunkPayload(
  i: number,
  chunks: string[],
  opts: ReplyChunkOpts,
): SendPayload {
  const shouldReplyTo =
    opts.reply_to != null && opts.replyMode !== 'off' && (opts.replyMode === 'all' || i === 0)
  return {
    content: chunks[i],
    ...(i === 0 && opts.files.length > 0 ? { files: opts.files } : {}),
    ...(shouldReplyTo
      ? { reply: { messageReference: opts.reply_to as string, failIfNotExists: false } }
      : {}),
  }
}

/**
 * Send each chunk with bounded retry. Chunks that already returned success are
 * never re-sent (the loop advances only on success), so a later chunk's failure
 * cannot duplicate an earlier delivered chunk. (This is not exactly-once for the
 * chunk currently being retried: if Discord accepted it but the response was
 * lost, the retry can duplicate that one chunk — the accepted at-least-once
 * trade-off versus silently dropping it.) On exhaustion the error is re-thrown
 * with guidance that steers the caller to send only the missing tail rather than
 * the whole message again — killing the partial-failure duplicate path. Returns
 * the delivered message ids.
 */
export async function sendReplyChunks(
  send: (payload: SendPayload) => Promise<{ id: string }>,
  chunks: string[],
  opts: ReplyChunkOpts,
  retryOpts: SendWithRetryOpts,
  onSent?: (id: string, payload: SendPayload) => void,
): Promise<string[]> {
  const sentIds: string[] = []
  try {
    for (let i = 0; i < chunks.length; i++) {
      const payload = buildChunkPayload(i, chunks, opts)
      const sent = await sendWithRetry(() => send(payload), retryOpts)
      // Record delivery before the injected callback so a throwing onSent can
      // never make the catch block under-report what actually went out.
      sentIds.push(sent.id)
      onSent?.(sent.id, payload)
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    const remaining = chunks.length - sentIds.length
    const guidance =
      sentIds.length > 0
        ? ` The ${sentIds.length} delivered chunk(s) are already in the channel — do NOT resend the full message; send only the remaining ${remaining} chunk(s) to avoid duplicates.`
        : ''
    throw new Error(
      `reply failed after delivering ${sentIds.length} of ${chunks.length} chunk(s): ${msg}.${guidance}`,
    )
  }
  return sentIds
}
