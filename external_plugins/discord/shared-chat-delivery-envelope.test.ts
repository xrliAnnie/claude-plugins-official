import { describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import {
  CHAT_DELIVERY_NORMALIZER_CONTRACT,
  encodeChatDeliveryEnvelope,
  normalizeChatDeliveryAttachments,
  normalizeChatDeliveryEnvelope,
  parseChatDeliveryEnvelope,
} from './shared-chat-delivery-envelope'
import { buildBeginArgs, encodeSpoolIntent, parseSpoolIntent } from './chat-receipt-recorder'

const golden = JSON.parse(readFileSync(new URL('./discord-chat-envelope-v1.json', import.meta.url), 'utf8'))
const contract = JSON.parse(readFileSync(new URL('./shared-discord-inbound-contract.json', import.meta.url), 'utf8')).envelope
describe('full canonical envelope parity', () => {
  it('uses the pinned complete schema, module, UTC validator and exact same golden cases', () => {
    expect(CHAT_DELIVERY_NORMALIZER_CONTRACT).toBe(golden.contract)
    expect(contract.contract).toBe(golden.contract)
    for (const [path, digest] of [
      ['./shared-chat-delivery-envelope.ts', contract.moduleSha256],
      ['./shared-discord-utc-timestamp.ts', contract.timestampSha256],
      ['./discord-chat-envelope-v1.json', contract.goldenSha256],
    ]) expect(createHash('sha256').update(readFileSync(new URL(path, import.meta.url))).digest('hex')).toBe(digest)
  })
  for (const { name, input, output, error } of golden.cases) {
    it(name, () => {
      const bytes = JSON.stringify(input)
      if (error) expect(() => normalizeChatDeliveryEnvelope(input)).toThrow(error)
      else {
        const envelope = normalizeChatDeliveryEnvelope(input)
        expect(envelope).toEqual(output)
        expect(parseChatDeliveryEnvelope(encodeChatDeliveryEnvelope(envelope))).toEqual(output)
        expect(normalizeChatDeliveryAttachments(input.attachments)).toEqual(output.attachments)
      }
      expect(JSON.stringify(input)).toBe(bytes)
    })
  }
  it('the real recorder and spool apply this same metadata policy through the complete producer route', () => {
    for (const { input, output, error } of golden.cases) {
      if (error || input.heldSince || input.origin || input.messageId.length < 17) continue
      const { messageId, originChannelId, authorId, authorName, ts, text, attachments, replyTo } = input
      const begin = buildBeginArgs({ messageId, originChannelId, authorId, authorName, ts, text, attachments, ...(replyTo ? { replyTo } : {}) }, {
        leadId: input.leadId, chatId: input.chatId,
        channelKind: input.msgKind === 'dm' ? 'dm' : 'guild',
        routedToRoundtable: input.msgKind === 'roundtable', inRoundtableThread: false,
        ...(input.replyRoute ? { replyRoute: input.replyRoute } : {}),
      })
      const { v: _version, deliveryId: _id, ...expected } = output
      expect(begin).toEqual({ ...expected, replyChannelId: expected.replyChannelId ?? input.chatId })
      expect(parseSpoolIntent(encodeSpoolIntent({ v: 1, begin, attempts: 0, advisedAt: null })).begin).toEqual(begin)
    }
  })
})
