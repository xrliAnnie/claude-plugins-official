import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

it('routes server guard calls and refusal formatting through the shared client', async () => {
  const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
  expect(source.includes('[reply-guard]')).toBe(true)
  const start = source.indexOf('const replyGuard = createReplyGuardClient(')
  expect(start).toBeGreaterThan(-1)
  const block = source.slice(start, source.indexOf('\nif (!TOKEN)', start))
  const calls: unknown[] = []
  const diagnostics: string[] = []
  let outcome: { kind: string; probe: { outcome: string }; local?: { classification: string; decision: string }; deny?: { reason: string } } = { kind: 'unavailable', probe: { outcome: 'abort' }, local: { classification: 'other', decision: 'allow' } }
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(block)
  const wrappers = new Function('createReplyGuardClient', 'formatGuardDeny', 'process', `${js}; return {callReplyGuard, guardDenyResult}`)(
    () => ({ evaluate: async (...args: unknown[]) => { calls.push(args); return outcome } }),
    (value: unknown) => { expect(value).toBe(outcome); return 'BLOCKED with probe=fixture' },
    { stderr: { write: (line: string) => diagnostics.push(line) } },
  )
  expect(await wrappers.callReplyGuard('cross-lead', 'FLY-1942', { roundtableThread: true })).toBeNull()
  expect(calls).toEqual([['cross-lead', 'FLY-1942', { roundtableThread: true }]])
  expect(diagnostics).toEqual(['[reply-guard] unavailable (abort); local=other decision=allow\n'])
  outcome = { kind: 'deny', probe: { outcome: 'ok' }, deny: { reason: 'issue_at_top_level' } }
  const denied = await wrappers.callReplyGuard('own-chat', 'FLY-1942')
  expect(denied).toBe(outcome)
  expect(diagnostics).toHaveLength(1)
  expect(wrappers.guardDenyResult(denied)).toEqual({ content: [{ type: 'text', text: 'BLOCKED with probe=fixture' }], isError: true })
})
