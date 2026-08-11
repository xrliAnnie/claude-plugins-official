import { describe, expect, it } from 'bun:test'
import {
  buildBeginArgs,
  deliveryInboundInstruction,
  deliveryReplyToDescription,
  deliveryReplyToolDescription,
  encodeSpoolIntent,
  isIntentFilename,
  parseSpoolIntent,
  resolveFounderId,
  resolveFounderIdForMode,
  resolveRecorderMode,
  type BeginArgs,
} from './chat-receipt-recorder'

const enabledEnv = {
  FLYWHEEL_COMM_CLI: '/opt/flywheel-comm.js',
  FLYWHEEL_COMM_DB: '/tmp/comm.db',
  FLYWHEEL_LEAD_ID: 'flywheel-eng-lead',
}

const baseMessage = {
  messageId: '100000000000000001',
  originChannelId: '100000000000000002',
  authorId: '100000000000000003',
  authorName: 'Annie',
  ts: '2026-07-23T05:00:00.000Z',
  text: 'Please inspect the delivery path.',
  attachments: [{ name: 'trace.png', type: 'image/png', sizeKb: 12 }],
}

describe('resolveRecorderMode', () => {
  it('enables only when the complete Flywheel capability tuple exists', () => {
    expect(resolveRecorderMode(enabledEnv)).toEqual({
      kind: 'enabled',
      commCli: '/opt/flywheel-comm.js',
      dbPath: '/tmp/comm.db',
      leadId: 'flywheel-eng-lead',
    })
  })

  it('keeps stock and intentionally isolated installs byte-compatible', () => {
    expect(resolveRecorderMode({})).toEqual({ kind: 'disabled', reason: 'stock' })
    expect(resolveRecorderMode({
      FLYWHEEL_LEAD_COMPANION: '1',
      FLYWHEEL_LEAD_ID: 'belle',
    })).toEqual({ kind: 'disabled', reason: 'isolated' })
  })

  it('ignores retired receipt rollout switches and stays on durable ingest', () => {
    expect(resolveRecorderMode({
      ...enabledEnv,
      FLYWHEEL_CHAT_RECEIPTS: '0',
      FLYWHEEL_MAILBOX_DISCORD: '0',
    })).toEqual({
      kind: 'enabled',
      commCli: '/opt/flywheel-comm.js',
      dbPath: '/tmp/comm.db',
      leadId: 'flywheel-eng-lead',
    })
  })

  it('fails loud for a non-isolated partial capability tuple', () => {
    expect(resolveRecorderMode({
      FLYWHEEL_LEAD_ID: 'flywheel-eng-lead',
      FLYWHEEL_COMM_CLI: '/opt/flywheel-comm.js',
      FLYWHEEL_COMM_DB: '',
    })).toEqual({ kind: 'broken', missing: ['FLYWHEEL_COMM_DB'] })
  })
})

describe('founder identity', () => {
  it('reads host Flywheel config only in enabled mode', () => {
    let reads = 0
    const input = {
      env: { DISCORD_OWNER_USER_ID: '100000000000000010' },
      readEnvFile: () => {
        reads++
        return 'DISCORD_OWNER_USER_ID=100000000000000011\n'
      },
    }
    expect(resolveFounderIdForMode({ kind: 'disabled', reason: 'isolated' }, input))
      .toBeUndefined()
    expect(reads).toBe(0)
    expect(resolveFounderIdForMode(resolveRecorderMode(enabledEnv), input))
      .toBe('100000000000000011')
    expect(reads).toBe(1)
  })

  it('prefers live dotenv and rejects malformed identities', () => {
    expect(resolveFounderId({
      env: { DISCORD_OWNER_USER_ID: '100000000000000010' },
      envFileText: 'DISCORD_OWNER_USER_ID=100000000000000011\n',
    })).toBe('100000000000000011')
    expect(resolveFounderId({
      env: { DISCORD_OWNER_USER_ID: 'bad' },
      envFileText: 'DISCORD_OWNER_USER_ID=also-bad\n',
    })).toBeUndefined()
  })
})

describe('durable ingest envelope', () => {
  const begin: BeginArgs = buildBeginArgs(
    baseMessage,
    {
      leadId: 'lead-a',
      chatId: '100000000000000020',
      channelKind: 'guild',
      routedToRoundtable: true,
      inRoundtableThread: false,
      replyRoute: {
        kind: 'roundtable_thread_from_message',
        parentChannelId: '100000000000000021',
        sourceMessageId: baseMessage.messageId,
        threadId: '100000000000000020',
      },
    },
    baseMessage.authorId,
  )

  it('keeps founder priority, routing, and restart-safe codec', () => {
    expect(begin).toMatchObject({
      priority: 0,
      msgKind: 'roundtable',
      replyChannelId: '100000000000000020',
    })
    expect(parseSpoolIntent(encodeSpoolIntent({
      v: 1,
      begin,
      attempts: 3,
      advisedAt: '2026-07-23T05:10:00.000Z',
    }))).toEqual({
      v: 1,
      begin,
      attempts: 3,
      advisedAt: '2026-07-23T05:10:00.000Z',
    })
    expect(isIntentFilename(`${begin.messageId}.json`)).toBe(true)
  })
})

describe('MCP copy', () => {
  it('is stock in every runtime mode and carries no settlement obligations', () => {
    const copy = [
      deliveryInboundInstruction(),
      deliveryReplyToolDescription(),
      deliveryReplyToDescription(),
    ]
    expect(copy).toEqual([
      'Messages from Discord arrive as <channel source="discord" chat_id="..." message_id="..." user="..." ts="...">. If the tag has attachment_count, the attachments attribute lists name/type/size — call download_attachment(chat_id, message_id) to fetch them. Reply with the reply tool — pass chat_id back. Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply, omit reply_to for normal responses.',
      'Reply on Discord. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or other files.',
      'Message ID to thread under. Use message_id from the inbound <channel> block, or an id from fetch_messages.',
    ])
    for (const text of copy) {
      expect(text).not.toContain('receipt_id')
      expect(text).not.toContain('handle-receipt')
      expect(text).not.toContain('settle')
    }
  })
})
