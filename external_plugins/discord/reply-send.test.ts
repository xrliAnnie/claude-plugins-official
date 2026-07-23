import { describe, it, expect } from 'bun:test'
import { RateLimitError } from '@discordjs/rest'
import { buildChunkPayload, sendReplyChunks, type SendPayload } from './reply-send'
import type { SendWithRetryOpts } from './retry'

// Immediate (no real wait) retry config for tests.
const fastRetry: SendWithRetryOpts = {
  maxRetries: 3,
  baseMs: 1,
  capMs: 1,
  sleep: async () => {},
  jitterRand: () => 0,
}

describe('buildChunkPayload', () => {
  const chunks = ['a', 'b', 'c']

  it('attaches files only to the first chunk', () => {
    const opts = { files: ['/x.png'], reply_to: undefined, replyMode: 'first' as const }
    expect(buildChunkPayload(0, chunks, opts).files).toEqual(['/x.png'])
    expect(buildChunkPayload(1, chunks, opts).files).toBeUndefined()
  })

  it('quote-replies on the first chunk only when replyMode=first', () => {
    const opts = { files: [], reply_to: 'm1', replyMode: 'first' as const }
    expect(buildChunkPayload(0, chunks, opts).reply).toEqual({
      messageReference: 'm1',
      failIfNotExists: false,
    })
    expect(buildChunkPayload(1, chunks, opts).reply).toBeUndefined()
  })

  it('quote-replies on every chunk when replyMode=all, never when off', () => {
    const all = { files: [], reply_to: 'm1', replyMode: 'all' as const }
    expect(buildChunkPayload(2, chunks, all).reply).toEqual({
      messageReference: 'm1',
      failIfNotExists: false,
    })
    const off = { files: [], reply_to: 'm1', replyMode: 'off' as const }
    expect(buildChunkPayload(0, chunks, off).reply).toBeUndefined()
  })
})

describe('sendReplyChunks', () => {
  const opts = { files: [], reply_to: undefined, replyMode: 'first' as const }

  it('sends every chunk once on success and returns ids', async () => {
    const seen: SendPayload[] = []
    let n = 0
    const ids = await sendReplyChunks(
      async p => { seen.push(p); return { id: `id${n++}` } },
      ['a', 'b', 'c'],
      opts,
      fastRetry,
    )
    expect(ids).toEqual(['id0', 'id1', 'id2'])
    expect(seen.map(p => p.content)).toEqual(['a', 'b', 'c'])
  })

  it('reports the exact successfully-sent payload to onSent', async () => {
    const callbacks: Array<{ id: string; payload: SendPayload }> = []
    await sendReplyChunks(
      async payload => ({ id: `sent-${payload.content}` }),
      ['answer'],
      { files: [], reply_to: 'inbound-1', replyMode: 'first' },
      fastRetry,
      (id, payload) => callbacks.push({ id, payload }),
    )
    expect(callbacks).toEqual([{
      id: 'sent-answer',
      payload: {
        content: 'answer',
        reply: {
          messageReference: 'inbound-1',
          failIfNotExists: false,
        },
      },
    }])
  })

  it('retries a transient failure within a chunk without duplicating earlier chunks', async () => {
    const sentContent: string[] = []
    let chunk1Attempts = 0
    const ids = await sendReplyChunks(
      async p => {
        if (p.content === 'b') {
          chunk1Attempts++
          if (chunk1Attempts < 2) throw { code: 'ECONNRESET' }
        }
        sentContent.push(p.content)
        return { id: p.content }
      },
      ['a', 'b'],
      opts,
      fastRetry,
    )
    // 'a' delivered exactly once even though 'b' had to retry.
    expect(sentContent.filter(c => c === 'a').length).toBe(1)
    expect(ids).toEqual(['a', 'b'])
  })

  it('does NOT re-send an already-delivered chunk when a later chunk exhausts retries', async () => {
    const delivered: string[] = []
    await expect(
      sendReplyChunks(
        async p => {
          if (p.content === 'b') throw { code: 'ETIMEDOUT' } // never succeeds
          delivered.push(p.content)
          return { id: p.content }
        },
        ['a', 'b', 'c'],
        opts,
        fastRetry,
      ),
    ).rejects.toThrow(
      /reply failed after delivering 1 of 3 chunk\(s\).*do NOT resend the full message; send only the remaining 2/s,
    )
    // 'a' sent exactly once; 'c' never attempted (loop stopped at the failed 'b').
    expect(delivered).toEqual(['a'])
  })

  it('omits the resend-guidance when nothing was delivered', async () => {
    await expect(
      sendReplyChunks(
        async () => { throw { status: 500 } },
        ['only'],
        opts,
        fastRetry,
      ),
    ).rejects.toThrow(/reply failed after delivering 0 of 1 chunk\(s\): .*\.$/)
  })

  it('does not retry a permanent error — fails fast', async () => {
    let calls = 0
    await expect(
      sendReplyChunks(
        async () => { calls++; throw { status: 403, code: 50013 } },
        ['x'],
        opts,
        fastRetry,
      ),
    ).rejects.toThrow(/reply failed after delivering 0 of 1/)
    expect(calls).toBe(1)
  })

  it('retries a real @discordjs/rest RateLimitError through the loop', async () => {
    let calls = 0
    const ids = await sendReplyChunks(
      async p => {
        calls++
        if (calls === 1) {
          throw new RateLimitError({
            timeToReset: 5,
            limit: 5,
            method: 'POST',
            hash: 'h',
            url: 'https://discord.com/api/v10/channels/1/messages',
            route: '/channels/:id/messages',
            majorParameter: '1',
            global: false,
            retryAfter: 5,
            sublimitTimeout: 0,
            scope: 'user',
          } as ConstructorParameters<typeof RateLimitError>[0])
        }
        return { id: p.content }
      },
      ['x'],
      opts,
      fastRetry,
    )
    expect(ids).toEqual(['x'])
    expect(calls).toBe(2)
  })
})
