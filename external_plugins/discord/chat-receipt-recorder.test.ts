import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import flagCases from './mailbox-discord-flag.fixture.json'
import {
  buildBeginArgs,
  encodeSpoolIntent,
  isIntentFilename,
  parseSpoolIntent,
  receiptInboundInstruction,
  receiptReplyToDescription,
  receiptReplyToolDescription,
  readMailboxDiscordFlag,
  resolveFounderId,
  resolveFounderIdForMode,
  resolveRecorderMode,
  sentMessageCarriesReference,
  shouldBlockDiscordSurface,
  type BeginArgs,
} from './chat-receipt-recorder'

const enabledEnv = {
  FLYWHEEL_COMM_CLI: '/opt/flywheel-comm.js',
  FLYWHEEL_COMM_DB: '/tmp/comm.db',
  FLYWHEEL_LEAD_ID: 'flywheel-eng-lead',
}

const enabledProbe = {
  stateDir: '/Users/test/.claude/channels/discord-flywheel-eng-lead',
  readOwnerFile: (_path: string) => undefined,
}

const baseMessage = {
  messageId: '100000000000000001',
  originChannelId: '100000000000000002',
  authorId: '100000000000000003',
  authorName: 'Annie',
  ts: '2026-07-23T05:00:00.000Z',
  text: 'Please inspect the receipt path.',
  attachments: [
    { name: 'trace.png', type: 'image/png', sizeKb: 12 },
  ],
}

describe('resolveRecorderMode', () => {
  it('enables only when the complete Flywheel capability tuple exists', () => {
    expect(resolveRecorderMode(enabledEnv, enabledProbe)).toEqual({
      kind: 'enabled',
      commCli: '/opt/flywheel-comm.js',
      dbPath: '/tmp/comm.db',
      leadId: 'flywheel-eng-lead',
    })
  })

  it('keeps a stock plugin install byte-compatible and disabled', () => {
    expect(resolveRecorderMode({}, enabledProbe)).toEqual({ kind: 'disabled', reason: 'stock' })
  })

  it('treats companion and external markers as intentional isolation', () => {
    expect(resolveRecorderMode({
      FLYWHEEL_LEAD_COMPANION: '1',
      FLYWHEEL_LEAD_ID: 'belle',
      FLYWHEEL_COMM_CLI: '',
      FLYWHEEL_COMM_DB: '  ',
    }, {
      stateDir: '/Users/test/.claude/channels/discord-belle',
      readOwnerFile: () => undefined,
    })).toEqual({ kind: 'disabled', reason: 'isolated' })

    expect(resolveRecorderMode({
      FLYWHEEL_LEAD_EXTERNAL: '1',
      FLYWHEEL_LEAD_ID: 'mufasa',
    }, {
      stateDir: '/tmp/custom-mufasa-state',
      readOwnerFile: () => 'mufasa\n',
    })).toEqual({ kind: 'disabled', reason: 'isolated' })
  })

  it('honours the explicit kill switch before classifying partial wiring', () => {
    expect(resolveRecorderMode({
      ...enabledEnv,
      FLYWHEEL_CHAT_RECEIPTS: '0',
    }, enabledProbe)).toEqual({ kind: 'disabled', reason: 'kill_switch' })

    expect(resolveRecorderMode({
      FLYWHEEL_LEAD_ID: 'flywheel-eng-lead',
      FLYWHEEL_CHAT_RECEIPTS: '0',
    }, enabledProbe)).toEqual({ kind: 'disabled', reason: 'kill_switch' })
  })

  it('fails loud for a non-isolated partial capability tuple', () => {
    expect(resolveRecorderMode({
      FLYWHEEL_LEAD_ID: 'flywheel-eng-lead',
      FLYWHEEL_COMM_CLI: '/opt/flywheel-comm.js',
      FLYWHEEL_COMM_DB: '',
    }, enabledProbe)).toEqual({
      kind: 'broken',
      missing: ['FLYWHEEL_COMM_DB'],
    })
  })

  it('fails closed when lead identity and the channel declaration owner disagree', () => {
    const foreignProbe = {
      stateDir: '/Users/test/.claude/channels/discord-flywheel-eng-lead',
      readOwnerFile: () => undefined,
    }
    for (const env of [
      enabledEnv,
      { ...enabledEnv, FLYWHEEL_CHAT_RECEIPTS: '0' },
      { ...enabledEnv, FLYWHEEL_COMM_DB: '' },
      { ...enabledEnv, FLYWHEEL_LEAD_COMPANION: '1' },
    ]) {
      const mode = resolveRecorderMode({
        ...env,
        FLYWHEEL_LEAD_ID: 'flywheel-product-lead',
      }, foreignProbe)
      expect(mode).toEqual({
        kind: 'miswired',
        leadId: 'flywheel-product-lead',
        stateDir: foreignProbe.stateDir,
      })
      expect(shouldBlockDiscordSurface(mode)).toBe(true)
    }
  })

  it('accepts an owner provisioned for a non-canonical QA state directory', () => {
    expect(resolveRecorderMode(enabledEnv, {
      stateDir: '/tmp/flywheel-test-slot-1/discord-state',
      readOwnerFile: () => 'flywheel-eng-lead\n',
    })).toEqual({
      kind: 'enabled',
      commCli: '/opt/flywheel-comm.js',
      dbPath: '/tmp/comm.db',
      leadId: 'flywheel-eng-lead',
    })
  })

  it('rejects missing, empty, unreadable, or foreign ownership declarations', () => {
    for (const stateDir of ['/Users/test/.claude/channels/discord', '']) {
      expect(resolveRecorderMode(enabledEnv, {
        stateDir,
        readOwnerFile: () => undefined,
      })).toMatchObject({ kind: 'miswired' })
    }
    for (const readOwnerFile of [
      () => undefined,
      () => 'flywheel-product-lead',
      () => { throw new Error('unreadable') },
    ]) {
      expect(resolveRecorderMode(enabledEnv, {
        stateDir: '/tmp/custom-state',
        readOwnerFile,
      })).toMatchObject({ kind: 'miswired' })
    }
  })

  it('uses the inherited environment snapshot rather than later state-dir dotenv values', () => {
    const inherited = { ...enabledEnv }
    const live = { ...inherited }
    live.FLYWHEEL_LEAD_ID = 'flywheel-product-lead'
    expect(resolveRecorderMode(inherited, enabledProbe)).toMatchObject({
      kind: 'enabled',
      leadId: 'flywheel-eng-lead',
    })
    expect(resolveRecorderMode(live, enabledProbe)).toMatchObject({
      kind: 'miswired',
      leadId: 'flywheel-product-lead',
    })
  })
})

describe('miswired server boundaries', () => {
  const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')

  it('snapshots inherited identity before loading state-dir dotenv', () => {
    expect(server.indexOf('const INHERITED_ENV = { ...process.env }'))
      .toBeLessThan(server.indexOf("chmodSync(ENV_FILE, 0o600)"))
    expect(server).toContain('const RECORDER_MODE = resolveRecorderMode(INHERITED_ENV, {')
  })

  it('blocks every gated surface before its prior side effects', () => {
    for (const boundary of [
      "function checkApprovals(): void {\n  if (blockMiswiredSurface('pairing_poller')) return",
      "async ({ params }) => {\n    if (blockMiswiredSurface('permission_request')) return",
      "client.on('interactionCreate', async (interaction: Interaction) => {\n  if (blockMiswiredSurface('interaction_create'",
      "client.on('messageCreate', msg => {\n  if (blockMiswiredSurface('message_create'",
      "async function handleInbound(msg: Message): Promise<void> {\n  if (blockMiswiredSurface('handle_inbound'",
    ]) expect(server).toContain(boundary)
  })
})

describe('FLYWHEEL_MAILBOX_DISCORD live contract', () => {
  it('enables only on the exact live dotenv value 1 and fails OFF on read errors', () => {
    for (const flagCase of flagCases) {
      expect(readMailboxDiscordFlag(() => flagCase.text)).toEqual({ enabled: flagCase.enabled })
    }
    expect(readMailboxDiscordFlag(() => '# FLYWHEEL_MAILBOX_DISCORD=1\n')).toEqual({ enabled: false })
    expect(readMailboxDiscordFlag(() => { throw new Error('unreadable') })).toEqual({
      enabled: false,
      readError: 'unreadable',
    })
  })
})

describe('resolveFounderId', () => {
  it('does not read the host Flywheel env outside enabled mode', () => {
    let reads = 0
    const input = {
      env: { DISCORD_OWNER_USER_ID: '100000000000000010' },
      readEnvFile: () => {
        reads++
        return 'DISCORD_OWNER_USER_ID=100000000000000011\n'
      },
    }
    expect(resolveFounderIdForMode(
      { kind: 'disabled', reason: 'isolated' },
      input,
    )).toBeUndefined()
    expect(resolveFounderIdForMode(
      { kind: 'broken', missing: ['FLYWHEEL_COMM_DB'] },
      input,
    )).toBeUndefined()
    expect(reads).toBe(0)

    expect(resolveFounderIdForMode(resolveRecorderMode(enabledEnv, enabledProbe), input))
      .toBe('100000000000000011')
    expect(reads).toBe(1)
  })

  it('prefers the live ~/.flywheel/.env value over inherited process env', () => {
    expect(resolveFounderId({
      env: { DISCORD_OWNER_USER_ID: '100000000000000010' },
      envFileText: 'DISCORD_OWNER_USER_ID=100000000000000011\n',
    })).toBe('100000000000000011')
  })

  it('uses the last uncommented live assignment during config rotation', () => {
    expect(resolveFounderId({
      env: { DISCORD_OWNER_USER_ID: '100000000000000010' },
      envFileText: [
        'DISCORD_OWNER_USER_ID=100000000000000011',
        '# DISCORD_OWNER_USER_ID=100000000000000012',
        'export DISCORD_OWNER_USER_ID="100000000000000013"',
      ].join('\n'),
    })).toBe('100000000000000013')
  })

  it('falls back to inherited env and rejects non-snowflakes', () => {
    expect(resolveFounderId({
      env: { DISCORD_OWNER_USER_ID: '100000000000000012' },
      envFileText: 'DISCORD_OWNER_USER_ID=not-a-snowflake\n',
    })).toBe('100000000000000012')
    expect(resolveFounderId({
      env: { DISCORD_OWNER_USER_ID: 'bad' },
      envFileText: '',
    })).toBeUndefined()
    expect(resolveFounderId({
      env: { DISCORD_OWNER_USER_ID: '123' },
      envFileText: '',
    })).toBeUndefined()
  })
})

describe('buildBeginArgs', () => {
  it('builds the CLI envelope and gives the founder P0 priority', () => {
    expect(buildBeginArgs(
      baseMessage,
      {
        leadId: 'flywheel-eng-lead',
        chatId: '100000000000000020',
        channelKind: 'guild',
        routedToRoundtable: false,
        inRoundtableThread: false,
        replyRoute: {
          kind: 'roundtable_thread_from_message',
          parentChannelId: '100000000000000021',
          sourceMessageId: baseMessage.messageId,
          threadId: '100000000000000020',
          threadName: 'mailbox routing',
        },
      },
      baseMessage.authorId,
    )).toEqual({
      leadId: 'flywheel-eng-lead',
      chatId: '100000000000000020',
      replyChannelId: '100000000000000020',
      replyRoute: {
        kind: 'roundtable_thread_from_message',
        parentChannelId: '100000000000000021',
        sourceMessageId: baseMessage.messageId,
        threadId: '100000000000000020',
        threadName: 'mailbox routing',
      },
      originChannelId: baseMessage.originChannelId,
      messageId: baseMessage.messageId,
      authorId: baseMessage.authorId,
      authorName: baseMessage.authorName,
      priority: 0,
      ts: baseMessage.ts,
      msgKind: 'guild',
      attachments: baseMessage.attachments,
      text: baseMessage.text,
    })
  })

  it('uses P1 when founder identity is unavailable and classifies all message kinds', () => {
    const dm = buildBeginArgs(
      baseMessage,
      {
        leadId: 'lead-a',
        chatId: '100000000000000021',
        channelKind: 'dm',
        routedToRoundtable: false,
        inRoundtableThread: false,
      },
      undefined,
    )
    const routed = buildBeginArgs(
      baseMessage,
      {
        leadId: 'lead-a',
        chatId: '100000000000000022',
        channelKind: 'guild',
        routedToRoundtable: true,
        inRoundtableThread: false,
      },
      '100000000000000099',
    )
    const inThread = buildBeginArgs(
      baseMessage,
      {
        leadId: 'lead-a',
        chatId: '100000000000000023',
        channelKind: 'guild',
        routedToRoundtable: false,
        inRoundtableThread: true,
      },
      '100000000000000099',
    )

    expect(dm).toMatchObject({ priority: 1, msgKind: 'dm' })
    expect(routed).toMatchObject({ priority: 1, msgKind: 'roundtable' })
    expect(inThread).toMatchObject({ priority: 1, msgKind: 'roundtable' })
  })
})

describe('spool intent codec', () => {
  const begin: BeginArgs = buildBeginArgs(
    baseMessage,
    {
      leadId: 'lead-a',
      chatId: '100000000000000020',
      channelKind: 'guild',
      routedToRoundtable: false,
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

  it('round-trips durable retry state', () => {
    const encoded = encodeSpoolIntent({
      v: 1,
      begin,
      attempts: 3,
      advisedAt: '2026-07-23T05:10:00.000Z',
    })
    expect(parseSpoolIntent(encoded)).toEqual({
      v: 1,
      begin,
      attempts: 3,
      advisedAt: '2026-07-23T05:10:00.000Z',
    })
  })

  it('rejects malformed intents and separates intent filenames from metadata', () => {
    expect(() => parseSpoolIntent('{"v":2}')).toThrow(/spool intent v1/)
    expect(isIntentFilename('100000000000000001.json')).toBe(true)
    expect(isIntentFilename('meta.json')).toBe(false)
    expect(isIntentFilename('100000000000000001.json.corrupt')).toBe(false)
    expect(isIntentFilename('123.json')).toBe(false)
  })

  it('upgrades a pre-route spool intent to its original chat id', () => {
    const { replyChannelId: _, replyRoute: __, ...legacyBegin } = begin
    expect(parseSpoolIntent(JSON.stringify({
      v: 1,
      begin: legacyBegin,
      attempts: 0,
      advisedAt: null,
    })).begin.replyChannelId).toBe(begin.chatId)
  })
})

describe('sentMessageCarriesReference', () => {
  it('settles only from the reference Discord persisted on the returned message', () => {
    expect(sentMessageCarriesReference({
      id: '100000000000000090',
      reference: { messageId: baseMessage.messageId },
    }, baseMessage.messageId)).toBe(true)
    expect(sentMessageCarriesReference({
      id: '100000000000000091',
      reference: null,
    }, baseMessage.messageId)).toBe(false)
    expect(sentMessageCarriesReference({
      id: '100000000000000092',
      reference: { messageId: '100000000000000099' },
    }, baseMessage.messageId)).toBe(false)
  })
})

describe('receipt-aware MCP copy', () => {
  const stockInbound = 'Messages from Discord arrive as <channel source="discord" chat_id="..." message_id="..." user="..." ts="...">. If the tag has attachment_count, the attachments attribute lists name/type/size — call download_attachment(chat_id, message_id) to fetch them. Reply with the reply tool — pass chat_id back. Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply, omit reply_to for normal responses.'
  const stockTool = 'Reply on Discord. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or other files.'
  const stockReplyTo = 'Message ID to thread under. Use message_id from the inbound <channel> block, or an id from fetch_messages.'

  it('preserves all three stock strings exactly when receipts are not enabled', () => {
    const disabled = { kind: 'disabled', reason: 'stock' } as const
    expect(receiptInboundInstruction(disabled)).toBe(stockInbound)
    expect(receiptReplyToolDescription(disabled)).toBe(stockTool)
    expect(receiptReplyToDescription(disabled)).toBe(stockReplyTo)
  })

  it('requires explicit reply_to only for receipted messages and explains roundtable ack', () => {
    const enabled = resolveRecorderMode(enabledEnv, enabledProbe)
    for (const copy of [
      receiptInboundInstruction(enabled),
      receiptReplyToolDescription(enabled),
      receiptReplyToDescription(enabled),
    ]) {
      expect(copy).toContain('receipt_id')
      expect(copy).toContain('reply_to')
      expect(copy).toContain('handle-receipt ack')
      expect(copy).toContain('topic thread')
    }
  })
})
