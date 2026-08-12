import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import flagCases from './mailbox-discord-flag.fixture.json'
import {
  buildBeginArgs,
  canMintChatReceipt,
  encodeSpoolIntent,
  isIntentFilename,
  parseSpoolIntent,
  receiptInboundInstruction,
  receiptReplyToDescription,
  receiptReplyToolDescription,
  readMailboxDiscordFlag,
  assertDiscordBotIdentity,
  resolveDiscordIdentity,
  resolveFounderId,
  resolveFounderIdForMode,
  resolveRecorderMode,
  sentMessageCarriesReference,
  type BeginArgs,
} from './chat-receipt-recorder'

const enabledEnv = {
  FLYWHEEL_COMM_CLI: '/opt/flywheel-comm.js',
  FLYWHEEL_COMM_DB: '/tmp/comm.db',
  FLYWHEEL_LEAD_ID: 'flywheel-eng-lead',
}

const projects = JSON.stringify([{
  projectName: 'flywheel',
  generalChannel: '100000000000000011',
  leads: [{
    agentId: 'flywheel-eng-lead',
    chatChannel: '100000000000000012',
    botTokenEnv: 'ENG_TOKEN',
    crossDeptChannels: ['100000000000000013'],
  }],
}])

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
    expect(resolveRecorderMode(enabledEnv, 'flywheel-eng-lead')).toEqual({
      kind: 'enabled',
      commCli: '/opt/flywheel-comm.js',
      dbPath: '/tmp/comm.db',
      leadId: 'flywheel-eng-lead',
    })
  })

  it('keeps a stock plugin install byte-compatible and disabled', () => {
    expect(resolveRecorderMode({})).toEqual({ kind: 'disabled', reason: 'stock' })
  })

  it('treats companion and external markers as intentional isolation', () => {
    expect(resolveRecorderMode({
      FLYWHEEL_LEAD_COMPANION: '1',
      FLYWHEEL_LEAD_ID: 'belle',
      FLYWHEEL_COMM_CLI: '',
      FLYWHEEL_COMM_DB: '  ',
    }, 'belle')).toEqual({ kind: 'disabled', reason: 'isolated' })

    expect(resolveRecorderMode({
      FLYWHEEL_LEAD_EXTERNAL: '1',
      FLYWHEEL_LEAD_ID: 'mufasa',
    }, 'mufasa')).toEqual({ kind: 'disabled', reason: 'isolated' })
  })

  it('honours the explicit kill switch before classifying partial wiring', () => {
    expect(resolveRecorderMode({
      ...enabledEnv,
      FLYWHEEL_CHAT_RECEIPTS: '0',
    }, 'flywheel-eng-lead')).toEqual({ kind: 'disabled', reason: 'kill_switch' })

    expect(resolveRecorderMode({
      FLYWHEEL_LEAD_ID: 'flywheel-eng-lead',
      FLYWHEEL_CHAT_RECEIPTS: '0',
    }, 'flywheel-eng-lead')).toEqual({ kind: 'disabled', reason: 'kill_switch' })
  })

  it('fails loud for a non-isolated partial capability tuple', () => {
    expect(resolveRecorderMode({
      FLYWHEEL_LEAD_ID: 'flywheel-eng-lead',
      FLYWHEEL_COMM_CLI: '/opt/flywheel-comm.js',
      FLYWHEEL_COMM_DB: '',
    }, 'flywheel-eng-lead')).toEqual({
      kind: 'broken',
      missing: ['FLYWHEEL_COMM_DB'],
    })
  })

  it('uses the canonical identity argument instead of a later mutable env value', () => {
    expect(resolveRecorderMode({
      ...enabledEnv,
      FLYWHEEL_LEAD_ID: 'flywheel-product-lead',
    }, 'flywheel-eng-lead')).toMatchObject({
      kind: 'enabled', leadId: 'flywheel-eng-lead',
    })
  })
})

describe('canonical Discord identity', () => {
  const registryEnv = {
    FLYWHEEL_LEAD_ID: 'flywheel-eng-lead',
    FLYWHEEL_DISCORD_IDENTITY_MODE: 'registry',
    FLYWHEEL_EXPECTED_DISCORD_BOT_USER_ID: '100000000000000099',
    DISCORD_BOT_TOKEN: 'generic-token',
  }

  it('defaults managed and stock adapters to the reversible legacy path', () => {
    expect(resolveDiscordIdentity({
      FLYWHEEL_LEAD_ID: 'flywheel-eng-lead',
      DISCORD_STATE_DIR: '/legacy/state',
      DISCORD_BOT_TOKEN: 'legacy-token',
    }, { homeDir: '/Users/test', readFile: () => { throw new Error('must not read') } })).toEqual({
      kind: 'legacy', stateDir: '/legacy/state', token: 'legacy-token',
    })
    expect(resolveDiscordIdentity({}, {
      homeDir: '/Users/test', readFile: () => { throw new Error('must not read') },
    })).toEqual({
      kind: 'legacy',
      stateDir: '/Users/test/.claude/channels/discord',
      token: undefined,
    })
  })

  it('mirrors inline then explicit-file then default-file registry precedence', () => {
    let reads = 0
    expect(resolveDiscordIdentity({
      ...registryEnv,
      FLYWHEEL_PROJECTS: projects,
      FLYWHEEL_PROJECTS_FILE: '/wrong/projects.json',
    }, {
      homeDir: '/Users/test',
      readFile: () => { reads++; throw new Error('inline must win') },
    })).toMatchObject({
      kind: 'registry',
      leadId: 'flywheel-eng-lead',
      registrySource: 'inline',
      stateDir: '/Users/test/.claude/channels/discord-flywheel-eng-lead',
      token: 'generic-token',
      expectedBotUserId: '100000000000000099',
    })
    expect(reads).toBe(0)

    const paths: string[] = []
    const deps = {
      homeDir: '/Users/test',
      readFile: (path: string) => { paths.push(path); return projects },
    }
    expect(resolveDiscordIdentity({
      ...registryEnv, FLYWHEEL_PROJECTS_FILE: '/slot/projects.json',
    }, deps)).toMatchObject({ registrySource: '/slot/projects.json' })
    expect(resolveDiscordIdentity(registryEnv, deps)).toMatchObject({
      registrySource: '/Users/test/.flywheel/projects.json',
    })
    expect(paths).toEqual([
      '/slot/projects.json',
      '/Users/test/.flywheel/projects.json',
    ])
  })

  it('uses named token when present, generic projection otherwise, and rejects drift', () => {
    expect(resolveDiscordIdentity({
      ...registryEnv, ENG_TOKEN: 'named-token', DISCORD_BOT_TOKEN: 'named-token',
      FLYWHEEL_PROJECTS: projects,
    }, { homeDir: '/Users/test', readFile: () => '' })).toMatchObject({ token: 'named-token' })
    expect(() => resolveDiscordIdentity({
      ...registryEnv, ENG_TOKEN: 'named-token', DISCORD_BOT_TOKEN: 'foreign-token',
      FLYWHEEL_PROJECTS: projects,
    }, { homeDir: '/Users/test', readFile: () => '' })).toThrow(/token.*conflict/i)
    expect(() => resolveDiscordIdentity({
      ...registryEnv, DISCORD_BOT_TOKEN: '', FLYWHEEL_PROJECTS: projects,
    }, { homeDir: '/Users/test', readFile: () => '' })).toThrow(/token.*missing/i)
  })

  it('derives canonical/custom state and rejects inherited state drift', () => {
    const custom = projects.replace('botTokenEnv":"ENG_TOKEN"',
      'botTokenEnv":"ENG_TOKEN","discordStateDir":"/slot/discord-state"')
    expect(resolveDiscordIdentity({
      ...registryEnv, FLYWHEEL_PROJECTS: custom,
    }, { homeDir: '/Users/test', readFile: () => '' })).toMatchObject({
      stateDir: '/slot/discord-state',
    })
    expect(() => resolveDiscordIdentity({
      ...registryEnv,
      FLYWHEEL_PROJECTS: projects,
      DISCORD_STATE_DIR: '/foreign/state',
    }, { homeDir: '/Users/test', readFile: () => '' })).toThrow(/state.*conflict/i)
  })

  it('fails loud on invalid mode, registry, lead cardinality, paths, and expected bot id', () => {
    const deps = { homeDir: '/Users/test', readFile: () => projects }
    expect(() => resolveDiscordIdentity({
      ...registryEnv, FLYWHEEL_DISCORD_IDENTITY_MODE: 'future',
    }, deps)).toThrow(/identity mode/i)
    expect(() => resolveDiscordIdentity({
      ...registryEnv, FLYWHEEL_PROJECTS: '{',
    }, deps)).toThrow(/registry/i)
    expect(() => resolveDiscordIdentity({
      ...registryEnv, FLYWHEEL_LEAD_ID: 'missing', FLYWHEEL_PROJECTS: projects,
    }, deps)).toThrow(/exactly one/i)
    expect(() => resolveDiscordIdentity({
      ...registryEnv,
      FLYWHEEL_PROJECTS: JSON.stringify([
        { leads: [{ agentId: 'flywheel-eng-lead' }] },
        { leads: [{ agentId: 'flywheel-eng-lead' }] },
      ]),
    }, deps)).toThrow(/exactly one/i)
    expect(() => resolveDiscordIdentity({
      ...registryEnv,
      FLYWHEEL_PROJECTS: JSON.stringify([{ leads: [{ agentId: 7 }] }]),
    }, deps)).toThrow(/agentId/i)
    expect(() => resolveDiscordIdentity({
      ...registryEnv,
      FLYWHEEL_PROJECTS: JSON.stringify([{
        leads: [{ agentId: 'flywheel-eng-lead', botTokenEnv: 7 }],
      }]),
    }, deps)).toThrow(/botTokenEnv/i)
    expect(() => resolveDiscordIdentity({
      ...registryEnv,
      FLYWHEEL_PROJECTS: projects.replace('botTokenEnv":"ENG_TOKEN"',
        'botTokenEnv":"ENG_TOKEN","discordStateDir":"relative"'),
    }, deps)).toThrow(/absolute/i)
    expect(() => resolveDiscordIdentity({
      ...registryEnv,
      FLYWHEEL_EXPECTED_DISCORD_BOT_USER_ID: 'wrong',
      FLYWHEEL_PROJECTS: projects,
    }, deps)).toThrow(/expected.*bot user/i)
  })

  it('fails before inbound handlers when Discord logged in as a foreign bot', () => {
    expect(() => assertDiscordBotIdentity(
      '100000000000000099', '100000000000000098',
    )).toThrow(/bot identity/i)
    expect(assertDiscordBotIdentity(
      '100000000000000099', '100000000000000099',
    )).toBeUndefined()
  })
})

describe('canonical server boundaries', () => {
  const server = readFileSync(new URL('./server.ts', import.meta.url), 'utf8')

  it('resolves inherited identity before loading state-dir dotenv', () => {
    expect(server.indexOf('const INHERITED_ENV = { ...process.env }'))
      .toBeLessThan(server.indexOf("chmodSync(ENV_FILE, 0o600)"))
    expect(server).toContain('const DISCORD_IDENTITY = resolveDiscordIdentity(INHERITED_ENV, {')
  })

  it('asserts the logged-in bot before any inbound handler can run', () => {
    const assertion = server.indexOf(
      'assertDiscordBotIdentity(DISCORD_IDENTITY.expectedBotUserId',
    )
    expect(assertion).toBeGreaterThan(-1)
    expect(assertion)
      .toBeLessThan(server.indexOf("client.on('interactionCreate'"))
    expect(assertion)
      .toBeLessThan(server.indexOf("client.on('messageCreate'"))
    expect(server).not.toContain('blockMiswiredSurface')
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

    expect(resolveFounderIdForMode(resolveRecorderMode(enabledEnv, 'flywheel-eng-lead'), input))
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
  it('mints roundtable receipts only for members declared by registry ground truth', () => {
    const parentId = '1512578695468941333'
    const threadId = '1536604232398938224'
    const members = [
      'tidal-echo-cos-lead',
      'sub-lead',
      'flywheel-cos-lead',
    ]
    const allLeads = [...members, 'claude-infra-bot-lead']
    const registry = JSON.stringify(allLeads.map((agentId, index) => ({
      projectName: `project-${index}`,
      leads: [{
        agentId,
        chatChannel: `10000000000000002${index}`,
        botTokenEnv: `TOKEN_${index}`,
        ...(members.includes(agentId) ? { crossDeptChannels: [parentId] } : {}),
      }],
    })))
    const identities = allLeads.map((leadId, index) => resolveDiscordIdentity({
      FLYWHEEL_LEAD_ID: leadId,
      FLYWHEEL_DISCORD_IDENTITY_MODE: 'registry',
      FLYWHEEL_EXPECTED_DISCORD_BOT_USER_ID: `10000000000000003${index}`,
      FLYWHEEL_PROJECTS: registry,
      [`TOKEN_${index}`]: `token-${index}`,
    }, { homeDir: '/Users/test', readFile: () => '' }))
    expect(identities.map(identity => canMintChatReceipt(identity, {
      channelKind: 'guild',
      channelId: threadId,
      parentChannelId: parentId,
    }))).toEqual([true, true, true, false])

    const receipts = identities.flatMap((identity, index) =>
      canMintChatReceipt(identity, {
        channelKind: 'guild', channelId: threadId, parentChannelId: parentId,
      }) ? [buildBeginArgs(
      baseMessage,
      {
        leadId: allLeads[index]!,
        chatId: threadId,
        channelKind: 'guild',
        routedToRoundtable: false,
        inRoundtableThread: true,
      },
      baseMessage.authorId,
      )] : [])
    expect(receipts.map(receipt => receipt.leadId)).toEqual(members)
    expect(receipts.every(receipt =>
      receipt.chatId === threadId && receipt.msgKind === 'roundtable')).toBe(true)
    expect(new Set(receipts.map(receipt =>
      `chat:${receipt.leadId}:${receipt.messageId}`)).size).toBe(3)
  })

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
    const enabled = resolveRecorderMode(enabledEnv, 'flywheel-eng-lead')
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
