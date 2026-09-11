import { expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'

it('routes server guard calls and refusal formatting through the shared client', async () => {
  const source = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
  const start = source.indexOf('const replyGuard = createReplyGuardClient(')
  expect(start).toBeGreaterThan(-1)
  const block = source.slice(start, source.indexOf('\nif (!TOKEN)', start))
  const calls: unknown[] = []
  let outcome: { kind: string; deny?: { reason: string } } = { kind: 'unavailable' }
  const js = new Bun.Transpiler({ loader: 'ts' }).transformSync(block)
  const wrappers = new Function('createReplyGuardClient', 'formatGuardDeny', `${js}; return {callReplyGuard, guardDenyResult}`)(
    () => ({ evaluate: async (...args: unknown[]) => { calls.push(args); return outcome } }),
    (value: unknown) => { expect(value).toBe(outcome); return 'BLOCKED with probe=fixture' },
  )
  expect(await wrappers.callReplyGuard('cross-lead', 'FLY-1942', { roundtableThread: true })).toBeNull()
  expect(calls).toEqual([['cross-lead', 'FLY-1942', { roundtableThread: true }]])
  outcome = { kind: 'deny', deny: { reason: 'issue_at_top_level' } }
  const denied = await wrappers.callReplyGuard('own-chat', 'FLY-1942')
  expect(denied).toBe(outcome)
  expect(wrappers.guardDenyResult(denied)).toEqual({ content: [{ type: 'text', text: 'BLOCKED with probe=fixture' }], isError: true })
})
