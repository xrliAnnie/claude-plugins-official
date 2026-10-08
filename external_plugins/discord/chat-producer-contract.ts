import { createHash } from 'node:crypto'
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { buildBeginArgs, type BeginArgs, type InboundMeta, type RoutingMeta } from './chat-receipt-recorder'
import {
  CHAT_DELIVERY_NORMALIZER_CONTRACT, normalizeChatDeliveryEnvelope,
} from './shared-chat-delivery-envelope'
import {
  DISCORD_INBOUND_CLASSIFIER_CONTRACT, classifyDiscordInbound,
} from './shared-discord-inbound-classifier'

// A compatibility fixture executed by this server, never a message delivery,
// account/session migration canary, activation receipt or recovery permission.
export interface ChatProducerContractMarker {
  v: 1
  contract: 'lead-discord-chat-producer/v1'
  scope: 'in_process_recorder_fixture'
  normalizer: string
  classifier: string
  envelopeFixtureSha256: string
  classifierFixtureSha256: string
  resultSha256: string
  envelopeCases: number
  classifierCases: number
  recorderCases: number
}

function fixture(name: string): { value: any; sha256: string } {
  const fd = openSync(new URL(name, import.meta.url), constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = fstatSync(fd)
    if (!before.isFile() || before.nlink !== 1 || before.uid !== process.getuid?.() ||
      before.mode & 0o022 || before.size > 64 * 1024) throw new Error('producer_fixture_unsafe')
    const bytes = readFileSync(fd)
    const after = fstatSync(fd)
    if (bytes.length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs) throw new Error('producer_fixture_changed')
    const value = JSON.parse(bytes.toString('utf8'))
    if (!Array.isArray(value.cases) || value.cases.length < 1 || value.cases.length > 128) throw new Error('producer_fixture_invalid')
    return { value, sha256: createHash('sha256').update(bytes).digest('hex') }
  } finally { closeSync(fd) }
}

export function probeChatProducerContract(
  recorder: typeof buildBeginArgs = buildBeginArgs,
): ChatProducerContractMarker {
  const envelope = fixture('./discord-chat-envelope-v1.json')
  const classifier = fixture('./discord-inbound-classifier-v1.json')
  if (envelope.value.contract !== CHAT_DELIVERY_NORMALIZER_CONTRACT ||
    classifier.value.contract !== DISCORD_INBOUND_CLASSIFIER_CONTRACT) throw new Error('producer_fixture_contract')
  const results: unknown[] = []
  let recorderCases = 0
  for (const row of envelope.value.cases) {
    const { input, output, error } = row
    if (error) {
      let rejected = false
      try { normalizeChatDeliveryEnvelope(input) } catch (failure) {
        rejected = failure instanceof Error && failure.message.includes(error)
      }
      if (!rejected) throw new Error('producer_negative_fixture_failed')
      results.push({ name: row.name, error })
      continue
    }
    if (!isDeepStrictEqual(normalizeChatDeliveryEnvelope(input), output)) throw new Error('producer_envelope_fixture_failed')
    results.push({ name: row.name, output })
    if (input.heldSince || input.origin || input.messageId.length < 17) continue
    const { messageId, originChannelId, authorId, authorName, ts, text, attachments, replyTo } = input
    const actual = recorder({ messageId, originChannelId, authorId, authorName, ts, text, attachments,
      ...(replyTo ? { replyTo } : {}) } as InboundMeta, {
      leadId: input.leadId, chatId: input.chatId,
      channelKind: input.msgKind === 'dm' ? 'dm' : 'guild',
      routedToRoundtable: input.msgKind === 'roundtable', inRoundtableThread: false,
      ...(input.replyRoute ? { replyRoute: input.replyRoute } : {}),
    } as RoutingMeta, input.priority === 0 ? input.authorId : undefined)
    const { v: _version, deliveryId: _id, ...expected } = output
    const begin: BeginArgs = { ...expected, replyChannelId: expected.replyChannelId ?? input.chatId }
    if (!isDeepStrictEqual(actual, begin)) throw new Error('producer_recorder_fixture_failed')
    results.push({ name: row.name, begin })
    recorderCases++
  }
  for (const row of classifier.value.cases) {
    if (!isDeepStrictEqual(classifyDiscordInbound({ ...classifier.value.base, ...row.patch }), row.expected)) {
      throw new Error('producer_classifier_fixture_failed')
    }
    results.push({ name: row.name, expected: row.expected })
  }
  if (recorderCases < 1) throw new Error('producer_recorder_fixture_empty')
  return {
    v: 1, contract: 'lead-discord-chat-producer/v1', scope: 'in_process_recorder_fixture',
    normalizer: CHAT_DELIVERY_NORMALIZER_CONTRACT, classifier: DISCORD_INBOUND_CLASSIFIER_CONTRACT,
    envelopeFixtureSha256: envelope.sha256, classifierFixtureSha256: classifier.sha256,
    resultSha256: createHash('sha256').update(JSON.stringify(results)).digest('hex'),
    envelopeCases: envelope.value.cases.length, classifierCases: classifier.value.cases.length, recorderCases,
  }
}
