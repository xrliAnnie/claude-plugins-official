/**
 * FLY-898 — per-group mention-pattern resolution. The reverse-compat / id-only
 * semantic that `resolveGroupMentionPatterns` encodes: an ABSENT per-group field
 * falls back to the global patterns (byte-compat); an EMPTY per-group array is
 * respected as id-only (must NOT fall back to global).
 */
import { test, expect, describe } from 'bun:test'
import { resolveGroupMentionPatterns } from './mention-patterns'

const GLOBAL = ['\\bPeter\\b', '\\bOliver\\b']

describe('resolveGroupMentionPatterns (FLY-898)', () => {
  test('no per-group field → falls back to global (byte-compat)', () => {
    expect(resolveGroupMentionPatterns({}, { mentionPatterns: GLOBAL })).toEqual(GLOBAL)
  })

  test('undefined policy → falls back to global', () => {
    expect(resolveGroupMentionPatterns(undefined, { mentionPatterns: GLOBAL })).toEqual(GLOBAL)
  })

  test('EMPTY per-group array → id-only, does NOT fall back to global', () => {
    // The core-room gate: [] must be respected, else a bare name would still pass.
    expect(resolveGroupMentionPatterns({ mentionPatterns: [] }, { mentionPatterns: GLOBAL })).toEqual([])
  })

  test('non-empty per-group array → overrides global', () => {
    const own = ['\\bAsha\\b']
    expect(resolveGroupMentionPatterns({ mentionPatterns: own }, { mentionPatterns: GLOBAL })).toEqual(own)
  })

  test('no per-group and no global → undefined (isMentioned then id-only)', () => {
    expect(resolveGroupMentionPatterns({}, {})).toBeUndefined()
  })

  test('EMPTY per-group with no global → [] (still id-only, not undefined)', () => {
    expect(resolveGroupMentionPatterns({ mentionPatterns: [] }, {})).toEqual([])
  })
})
