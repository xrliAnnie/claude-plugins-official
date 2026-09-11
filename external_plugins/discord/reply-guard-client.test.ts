import { describe, expect, test } from 'bun:test'
import { createReplyGuardClient, formatGuardDeny } from './reply-guard-client'
const base = {
  BRIDGE_URL: 'http://localhost:9876',
  TEAMLEAD_API_TOKEN: 'secret',
  LEAD_ID: 'lead',
  PROJECT_NAME: 'project',
  DISCORD_OWN_CHAT_CHANNEL: 'own',
  DISCORD_CORE_CHANNEL: 'core',
}
function harness(
  responses: Array<Response | Error>,
  env: NodeJS.ProcessEnv = base,
) {
  const audits: Record<string, unknown>[] = [],
    sleeps: number[] = []
  let calls = 0,
    clock = 1000
  const client = createReplyGuardClient({
    env,
    fetchImpl: (async () => {
      calls++
      clock += 3
      const r = responses.shift()
      if (r instanceof Error) throw r
      return r!
    }) as typeof fetch,
    now: () => clock,
    sleep: async (ms) => {
      sleeps.push(ms)
      clock += ms
    },
    audit: (row) => {
      audits.push(row)
    },
  })
  return { ...client, audits, sleeps, calls: () => calls }
}
const abort = () => new DOMException('aborted', 'AbortError')
const response = (status: number, body: unknown = { allow: true }) =>
  new Response(JSON.stringify(body), { status })
describe('reply guard policy and probe', () => {
  test('retries one abort and accepts healthy second result', async () => {
    const h = harness([abort(), response(200)])
    const r = await h.evaluate('own', 'FLY-1')
    expect(r.kind).toBe('allow')
    expect(r.probe.attempts).toBe(2)
    expect(h.sleeps).toEqual([250])
    expect(h.audits).toEqual([])
  })
  test('two aborts permit cross-Lead issue content and audit exact readings', async () => {
    const h = harness([abort(), abort()])
    const r = await h.evaluate('other', 'FLY-1')
    expect(r.kind).toBe('unavailable')
    expect(r.local).toEqual({
      classification: 'other',
      issueTokens: ['FLY-1'],
      decision: 'allow',
    })
    expect(r.deny).toBeUndefined()
    expect(r.probe).toMatchObject({
      attempts: 2,
      timeoutMs: 4000,
      outcome: 'abort',
      latencyMs: 256,
    })
    expect(h.audits).toHaveLength(1)
  })
  test('own-channel denial omits empty Issues and includes probe', async () => {
    const h = harness([abort(), abort()])
    const r = await h.evaluate('own', 'FLY-1')
    expect(r.deny?.reason).toBe('guard_unavailable')
    const text = formatGuardDeny(r)
    expect(text).not.toContain('Issues:')
    for (const field of [
      'probe={',
      'url=',
      'attempts=2',
      'timeout_ms=4000',
      'outcome=abort',
      'latency_ms=256',
      'at=',
      'local=own_top_level',
    ])
      expect(text).toContain(field)
  })
  test('401 is unauthorized, has no retry and own-channel denies', async () => {
    const h = harness([response(401)])
    const r = await h.evaluate('own', 'FLY-1')
    expect(r.kind).toBe('unauthorized')
    expect(r.deny?.reason).toBe('guard_unauthorized')
    expect(h.calls()).toBe(1)
    expect(h.sleeps).toEqual([])
    expect(r.probe.httpStatus).toBe(401)
  })
  test('404 means not deployed, allows without audit', async () => {
    const h = harness([response(404)])
    const r = await h.evaluate('own', 'FLY-1')
    expect(r.kind).toBe('not_deployed')
    expect(r.deny).toBeUndefined()
    expect(h.audits).toEqual([])
  })
  test('healthy Bridge denial stays authoritative even for core', async () => {
    const deny = {
      allow: false,
      reason: 'issue_at_top_level',
      issues: ['FLY-1'],
      guidance: 'Use thread',
    }
    const h = harness([response(200, deny)])
    const r = await h.evaluate('core', 'FLY-1')
    expect(r.kind).toBe('deny')
    expect(r.deny).toEqual({
      reason: deny.reason,
      issues: deny.issues,
      guidance: deny.guidance,
    })
    expect(formatGuardDeny(r)).toContain('Issues: FLY-1.')
    expect(h.audits).toHaveLength(1)
  })
  test('missing own-channel env preserves legacy broad denial', async () => {
    const h = harness([abort(), abort()], {
      ...base,
      DISCORD_OWN_CHAT_CHANNEL: undefined,
    })
    const r = await h.evaluate('other', 'FLY-1')
    expect(r.local?.classification).toBe('legacy_broad')
    expect(r.deny?.reason).toBe('guard_unavailable_legacy_broad')
  })
  test('core and known roundtable threads allow locally during failure', async () => {
    for (const [id, opts, classification] of [
      ['core', {}, 'core'],
      ['topic', { roundtableThread: true }, 'roundtable_thread'],
    ] as const) {
      const h = harness([abort(), abort()])
      const r = await h.evaluate(id, 'FLY-1', opts)
      expect(r.local?.classification).toBe(classification)
      expect(r.deny).toBeUndefined()
    }
  })
  test('audit exception never changes decision', async () => {
    const h = createReplyGuardClient({
      env: base,
      fetchImpl: (async () => response(401)) as typeof fetch,
      audit: () => {
        throw Error('full')
      },
    })
    expect((await h.evaluate('other', 'FLY-1')).deny).toBeUndefined()
  })
  test('network retry, HTTP no retry, freeform own channel allow', async () => {
    const net = harness([TypeError('fetch failed'), response(200)])
    expect((await net.evaluate('other', 'FLY-1')).kind).toBe('allow')
    expect(net.calls()).toBe(2)
    const http = harness([response(503)])
    const result = await http.evaluate('own', 'hello')
    expect(http.calls()).toBe(1)
    expect(result.local?.decision).toBe('allow')
    expect(result.probe.outcome).toBe('http')
  })
  test('issue prefix matching preserves case-insensitive boundary semantics', async () => {
    for (const [text, denied] of [
      ['fly-1', true],
      ['XFLY-1', false],
      ['FLY-1x', false],
      ['FOO-2', false],
      ['GEO-42', true],
    ] as const) {
      const h = harness([response(503)])
      expect(Boolean((await h.evaluate('own', text)).deny)).toBe(denied)
    }
  })
  test('timeout parser retains existing fallback semantics', async () => {
    for (const [raw, expected] of [
      ['500', 500],
      ['10000', 10000],
      ['499', 4000],
      ['10001', 4000],
      ['500ms', 4000],
    ] as const) {
      const h = harness([response(503)], {
        ...base,
        TEAMLEAD_REPLY_GUARD_TIMEOUT_MS: raw,
      })
      expect((await h.evaluate('other', 'FLY-1')).probe.timeoutMs).toBe(
        expected,
      )
    }
  })
})

test('probe and audit redact API token from thrown fetch diagnostics', async () => {
  const h = harness([
    Error('request Bearer secret failed'),
    Error('request Bearer secret failed'),
  ])
  const r = await h.evaluate('own', 'FLY-1')
  expect(JSON.stringify(r)).not.toContain('secret')
  expect(JSON.stringify(h.audits)).not.toContain('secret')
  expect(formatGuardDeny(r)).not.toContain('secret')
})

import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
test('default audit rotates at1MB, creates bounded JSONL and excludes request credentials/body', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'guard-audit-'))
  try {
    const path = join(dir, 'reply-guard-audit.jsonl')
    writeFileSync(path, 'x'.repeat(1024 * 1024))
    writeFileSync(`${path}.1`, 'old')
    const client = createReplyGuardClient({
      env: { ...base, DISCORD_STATE_DIR: dir },
      fetchImpl: (async () => response(503)) as typeof fetch,
    })
    await client.evaluate('other', 'FLY-1 private-message')
    expect(statSync(`${path}.1`).size).toBe(1024 * 1024)
    const text = readFileSync(path, 'utf8')
    expect(JSON.parse(text).local.classification).toBe('other')
    expect(text).not.toContain('secret')
    expect(text).not.toContain('private-message')
    expect(readdirSync(dir).sort()).toEqual([
      'reply-guard-audit.jsonl',
      'reply-guard-audit.jsonl.1',
    ])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
test('configured deadline actually aborts fetch and retries once', async () => {
  let calls = 0
  const client = createReplyGuardClient({
    env: { ...base, TEAMLEAD_REPLY_GUARD_TIMEOUT_MS: '500' },
    sleep: async () => {},
    audit: () => {},
    fetchImpl: ((_: unknown, init?: RequestInit) =>
      new Promise((_, reject) => {
        calls++
        init!.signal!.addEventListener('abort', () => reject(abort()), {
          once: true,
        })
      })) as typeof fetch,
  })
  const r = await client.evaluate('other', 'FLY-1')
  expect(calls).toBe(2)
  expect(r.probe.outcome).toBe('abort')
  expect(r.probe.latencyMs).toBeGreaterThanOrEqual(990)
})
test('guard disabled without bindings sends no request; enabled POST retains original contract', async () => {
  let calls = 0
  let init: RequestInit | undefined
  const fetchImpl = (async (_: unknown, i: RequestInit) => {
    calls++
    init = i
    return response(200)
  }) as typeof fetch
  expect(
    (
      await createReplyGuardClient({ env: {}, fetchImpl }).evaluate(
        'own',
        'FLY-1',
      )
    ).probe.attempts,
  ).toBe(0)
  expect(calls).toBe(0)
  await createReplyGuardClient({ env: base, fetchImpl }).evaluate(
    'own',
    'FLY-1',
  )
  expect(init?.method).toBe('POST')
  expect((init?.headers as Record<string, string>).Authorization).toBe(
    'Bearer secret',
  )
  expect(JSON.parse(init!.body as string)).toEqual({
    projectName: 'project',
    leadId: 'lead',
    chatId: 'own',
    text: 'FLY-1',
  })
})
