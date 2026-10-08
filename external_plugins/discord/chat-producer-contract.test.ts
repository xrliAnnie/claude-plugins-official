import { expect, it } from 'bun:test'
import { buildBeginArgs } from './chat-receipt-recorder'
import { probeChatProducerContract } from './chat-producer-contract'

it('proves the complete current recorder, normalizer and classifier without sending a message', () => {
  expect(probeChatProducerContract()).toMatchObject({
    v: 1, scope: 'in_process_recorder_fixture', envelopeCases: 15, classifierCases: 23,
  })
})
it('refuses an older producer that loses attachment identity or reply references', () => {
  for (const remove of ['attachments', 'replyTo', 'replyRoute'] as const) {
    expect(() => probeChatProducerContract((...args) => {
      const result = buildBeginArgs(...args)
      delete (result as any)[remove]
      return result
    })).toThrow('producer_recorder_fixture_failed')
  }
})
