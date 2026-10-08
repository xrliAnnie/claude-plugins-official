import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  DISCORD_INBOUND_CLASSIFIER_CONTRACT,
  classifyDiscordInbound,
  classifyDiscordPermissionReply,
} from './shared-discord-inbound-classifier'

const golden = JSON.parse(readFileSync(new URL('./discord-inbound-classifier-v1.json', import.meta.url), 'utf8'))
const contract = JSON.parse(readFileSync(new URL('./shared-discord-inbound-contract.json', import.meta.url), 'utf8'))
describe('exact shared inbound policy contract', () => {
  it('uses the identical pinned canonical module and full golden fixture', () => {
    expect(DISCORD_INBOUND_CLASSIFIER_CONTRACT).toBe(golden.contract)
    expect(contract.contract).toBe(golden.contract)
    for (const [path, digest] of [
      ['./shared-discord-inbound-classifier.ts', contract.sourceSha256],
      ['./discord-inbound-classifier-v1.json', contract.goldenSha256],
    ]) expect(createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')).toBe(digest)
  })
  for (const { name, patch, expected } of golden.cases) {
    it(name, () => {
      const input = { ...golden.base, ...patch }, bytes = JSON.stringify(input)
      expect(classifyDiscordInbound(input)).toEqual(expected)
      expect(JSON.stringify(input)).toBe(bytes)
    })
  }
  it('keeps permission decisions separate from chat and never dispatches approvals', () => {
    expect(classifyDiscordPermissionReply(' n FGHJK ')).toEqual({ requestId: 'fghjk', behavior: 'deny' })
    for (const text of ['prefix yes abcde', 'yes abcde\nno fghij', 'y 12345', 'yes abcle']) expect(classifyDiscordPermissionReply(text)).toBeNull()
  })
  it('the actual gateway uses this policy and preserves topic budgeting, pairing and reference resolution', () => {
    const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')
    expect(server).toContain("from './shared-discord-inbound-classifier'")
    expect(server).toContain('classifyDiscordInbound(')
    expect(server).toContain('classifyDiscordPermissionReply(msg.content)')
    expect(server).not.toContain('const PERMISSION_REPLY_RE =')
    expect(server).toContain('decideTopicThreadHandling(')
    expect(server).toContain('saveAccess(access)')
    expect(server).toContain('await msg.fetchReference()')
  })
})
