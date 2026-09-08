import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ChatIngestRuntime,
  type CommandResult,
} from './chat-receipt-runtime'
import {
  buildRejectedIntent,
  encodeRejectedIntent,
  parseRejectedIntent,
  resolveRecorderMode,
  type BeginArgs,
  type RecorderMode,
} from './chat-receipt-recorder'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fly1645-ingest-runtime-'))
  tempDirs.push(dir)
  return dir
}

const begin: BeginArgs = {
  leadId: 'flywheel-eng-lead',
  chatId: '100000000000000010',
  replyChannelId: '100000000000000010',
  originChannelId: '100000000000000010',
  messageId: '100000000000000011',
  authorId: '100000000000000012',
  authorName: 'Annie',
  priority: 0,
  ts: '2026-08-11T05:00:00.000Z',
  msgKind: 'guild',
  attachments: [{ name: 'trace.png', type: 'image/png', sizeKb: 5 }],
  text: 'Please handle this.',
}

const inbound = {
  messageId: begin.messageId,
  originChannelId: begin.originChannelId,
  authorId: begin.authorId,
  authorName: begin.authorName,
  ts: begin.ts,
  text: begin.text,
  attachments: begin.attachments,
}

const routing = {
  chatId: begin.chatId,
  channelKind: 'guild' as const,
  routedToRoundtable: false,
  inRoundtableThread: false,
}

function rejectedIntent(
  messageId: string,
  receivedAt = '2026-08-11T05:00:01.000Z',
  ts = '2026-08-11T05:00:00.000Z',
) {
  return buildRejectedIntent(
    { ...inbound, messageId, ts },
    routing,
    ['FLYWHEEL_COMM_DB'],
    new Date(receivedAt),
  )
}

function writeRejected(dir: string, intent: ReturnType<typeof rejectedIntent>): string {
  const rejectedDir = join(dir, 'chat-receipt-spool', 'rejected')
  mkdirSync(rejectedDir, { recursive: true })
  const path = join(rejectedDir, `${intent.inbound.messageId}.json`)
  writeFileSync(path, encodeRejectedIntent(intent))
  return path
}

function enabledMode(): RecorderMode {
  return {
    kind: 'enabled',
    commCli: '/opt/flywheel-comm.js',
    dbPath: join(tempDir(), 'comm.db'),
    leadId: begin.leadId,
  }
}

function result(stdout = '', exitCode = 0, stderr = ''): CommandResult {
  return { stdout, stderr, exitCode, timedOut: false }
}

describe('durable Discord ingest runtime', () => {
  it('has no receipt or Discord advisory injection surface', () => {
    const runtimeSource = readFileSync(join(import.meta.dir, 'chat-receipt-runtime.ts'), 'utf8')
    const serverSource = readFileSync(join(import.meta.dir, 'server.ts'), 'utf8')

    expect(runtimeSource).not.toMatch(/\bAdviseFn\b/)
    expect(runtimeSource).not.toContain('advise:')
    expect(runtimeSource).not.toContain('adviseBroken')
    expect(serverSource).not.toContain('advise: async')
    expect(serverSource).not.toContain('.adviseBroken(')
    expect(serverSource).not.toContain('content: `⚠️ ${text}`')
    expect(serverSource).not.toContain('chatIngestRuntime.settle')
    expect(serverSource.match(/method: 'notifications\/claude\/channel',/g) ?? [])
      .toHaveLength(1)
    expect(serverSource).toMatch(
      /await chatIngestRuntime\.acceptInbound\(ingestArgs\)[\s\S]{0,120}chatIngestRuntime\.kickWorker\(\)/,
    )
    expect(serverSource).toContain(': await chatIngestRuntime.holdInbound(rejectedIntent)')
    expect(serverSource).toContain('inbound delivery is FAIL-CLOSED')
    const rejectedStart = serverSource.indexOf("if (delivery === 'rejected')")
    const typingStart = serverSource.indexOf('// Typing keepalive', rejectedStart)
    expect(rejectedStart).toBeGreaterThan(0)
    expect(typingStart).toBeGreaterThan(rejectedStart)
    const rejectedBlock = serverSource.slice(rejectedStart, typingStart)
    expect(rejectedBlock).toContain('msg.react(REJECTED_REACTION)')
    expect(rejectedBlock).not.toContain('mcp.notification')
    expect(rejectedBlock).not.toContain('.send(')
    expect(rejectedBlock).not.toContain('.reply(')
    expect(rejectedBlock).not.toContain('startTypingKeepalive')
  })

  it('always invokes chat-ingest and never invokes a receipt command', async () => {
    const commands: string[][] = []
    const runtime = new ChatIngestRuntime({
      mode: enabledMode(),
      stateDir: tempDir(),
      runCommand: async argv => {
        commands.push(argv)
        return result(JSON.stringify({ lane: 'inserted_inbox' }))
      },
    })

    expect(await runtime.acceptInbound(begin)).toBe('mailbox')
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain('chat-ingest')
    expect(commands[0]).not.toContain('chat-receipt')
    expect(commands[0]).not.toContain('settle')
  })

  it('writes an ingest intent before the CLI and removes it on an authoritative verdict', async () => {
    const dir = tempDir()
    const intent = join(dir, 'chat-receipt-spool', 'ingest', `${begin.messageId}.json`)
    let presentDuringCli = false
    const runtime = new ChatIngestRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand: async () => {
        presentDuringCli = existsSync(intent)
        return result(JSON.stringify({ lane: 'active_inbox' }))
      },
    })

    expect(await runtime.acceptInbound(begin)).toBe('mailbox')
    expect(presentDuringCli).toBe(true)
    expect(existsSync(intent)).toBe(false)
  })

  it('never raw-falls-back on ambiguity and replays a durable ingest intent', async () => {
    const dir = tempDir()
    const intent = join(dir, 'chat-receipt-spool', 'ingest', `${begin.messageId}.json`)
    const timers: Array<{ fn: () => void; ms: number }> = []
    let now = new Date('2026-08-11T05:00:00.000Z')
    let calls = 0
    const runtime = new ChatIngestRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand: async () => {
        calls++
        return calls <= 2
          ? result('', 1, 'ambiguous')
          : result(JSON.stringify({ lane: 'active_inbox' }))
      },
      now: () => now,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms })
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    expect(await runtime.acceptInbound(begin)).toBe('mailbox')
    expect(calls).toBe(2)
    expect(existsSync(intent)).toBe(true)
    expect(timers).toHaveLength(1)
    now = new Date('2026-08-11T05:00:06.000Z')
    timers[0]!.fn()
    await runtime.whenIdle()
    expect(calls).toBe(3)
    expect(existsSync(intent)).toBe(false)
  })

  it('keeps a bounded retry when durable schedule updates fail', async () => {
    const timers: number[] = []
    let writes = 0
    const runtime = new ChatIngestRuntime({
      mode: enabledMode(),
      stateDir: tempDir(),
      writeIngestIntent: (path, intent) => {
        writes++
        if (writes > 1) throw new Error('disk full')
        writeFileSync(path, JSON.stringify(intent))
      },
      runCommand: async () => result('', 1, 'ambiguous'),
      setTimer: (_fn, ms) => {
        timers.push(ms)
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    expect(await runtime.acceptInbound(begin)).toBe('mailbox')
    expect(timers).toEqual([5_000])
  })

  it('logs an unrecoverable ingest when neither durability nor immediate delivery works', async () => {
    const logs: string[] = []
    const runtime = new ChatIngestRuntime({
      mode: enabledMode(),
      stateDir: tempDir(),
      writeIngestIntent: () => { throw new Error('disk full') },
      runCommand: async () => result('', 1, 'mailbox unavailable'),
      log: line => logs.push(line),
    })

    await runtime.acceptInbound(begin)
    expect(logs.filter(line => line.includes('discord_mailbox_ingest_unrecoverable'))).toHaveLength(1)
  })

  it('logs corrupt recovery intents once without creating an advisory marker', async () => {
    const dir = tempDir()
    const ingestDir = join(dir, 'chat-receipt-spool', 'ingest')
    const intent = join(ingestDir, `${begin.messageId}.json`)
    const logs: string[] = []
    mkdirSync(ingestDir, { recursive: true })
    writeFileSync(intent, '{invalid')
    const runtime = new ChatIngestRuntime({
      mode: enabledMode(),
      stateDir: dir,
      log: line => logs.push(line),
    })

    runtime.kickWorker()
    await runtime.whenIdle()
    expect(existsSync(`${intent}.corrupt`)).toBe(true)
    expect(logs.filter(line => line.includes('discord_mailbox_ingest_corrupt_intent'))).toHaveLength(1)
    expect(existsSync(join(dir, 'chat-receipt-spool', 'meta', 'ingest-corrupt-advised.json'))).toBe(false)
  })

  it('makes no worker progress when a corrupt intent cannot be quarantined', async () => {
    const dir = tempDir()
    const ingestDir = join(dir, 'chat-receipt-spool', 'ingest')
    const intent = join(ingestDir, `${begin.messageId}.json`)
    mkdirSync(`${intent}.corrupt`, { recursive: true })
    writeFileSync(intent, '{invalid')
    const runtime = new ChatIngestRuntime({
      mode: enabledMode(),
      stateDir: dir,
    })

    const pass = await (runtime as unknown as {
      drainIngestPass(): Promise<{ progress: boolean; workRemains: boolean }>
    }).drainIngestPass()
    expect(pass).toEqual({ progress: false, workRemains: true })
  })

  it('logs a stalled ingest once and persists the existing latch', async () => {
    const dir = tempDir()
    const ingestDir = join(dir, 'chat-receipt-spool', 'ingest')
    const intentPath = join(ingestDir, `${begin.messageId}.json`)
    const now = new Date('2026-08-11T05:06:00.000Z')
    const logs: string[] = []
    mkdirSync(ingestDir, { recursive: true })
    writeFileSync(intentPath, JSON.stringify({
      v: 1,
      begin,
      firstFailedAt: '2026-08-11T05:00:00.000Z',
      nextAttemptAt: '2026-08-11T05:00:00.000Z',
      attempts: 5,
      advisedAt: null,
    }))
    const runtime = new ChatIngestRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand: async () => result('', 1, 'mailbox unavailable'),
      now: () => now,
      log: line => logs.push(line),
      setTimer: () => 1 as unknown as ReturnType<typeof setTimeout>,
      clearTimer: () => {},
    })

    runtime.kickWorker()
    await runtime.whenIdle()
    expect(JSON.parse(readFileSync(intentPath, 'utf8')).advisedAt).toBe(now.toISOString())
    expect(logs.filter(line => line.includes('discord_mailbox_ingest_stalled'))).toHaveLength(1)
  })

  for (const missing of [
    'FLYWHEEL_COMM_CLI',
    'FLYWHEEL_COMM_DB',
    'FLYWHEEL_LEAD_ID',
  ] as const) {
    it(`fails closed and durably holds inbound when ${missing} is absent`, async () => {
      const dir = tempDir()
      const env: Record<string, string | undefined> = {
        FLYWHEEL_COMM_CLI: '/opt/flywheel-comm.js',
        FLYWHEEL_COMM_DB: '/tmp/comm.db',
        FLYWHEEL_LEAD_ID: 'flywheel-eng-lead',
      }
      delete env[missing]
      const mode = resolveRecorderMode(env)
      expect(mode).toEqual({ kind: 'broken', missing: [missing] })
      const commands: string[][] = []
      const runtime = new ChatIngestRuntime({
        mode,
        stateDir: dir,
        runCommand: async argv => {
          commands.push(argv)
          return result()
        },
      })
      const intent = buildRejectedIntent(
        inbound,
        routing,
        [missing],
        new Date('2026-08-11T05:00:01.000Z'),
      )

      expect(await runtime.holdInbound(intent)).toBe('rejected')
      expect(commands).toEqual([])
      expect(parseRejectedIntent(readFileSync(join(
        dir,
        'chat-receipt-spool',
        'rejected',
        `${begin.messageId}.json`,
      ), 'utf8'))).toMatchObject({
        missing: [missing],
        inbound: { text: begin.text },
      })
    })
  }

  it('keeps the first complete rejected intent on duplicate and conflict', async () => {
    const dir = tempDir()
    const logs: string[] = []
    const runtime = new ChatIngestRuntime({
      mode: { kind: 'broken', missing: ['FLYWHEEL_COMM_DB'] },
      stateDir: dir,
      log: line => logs.push(line),
    })
    const first = buildRejectedIntent(
      inbound,
      routing,
      ['FLYWHEEL_COMM_DB'],
      new Date('2026-08-11T05:00:01.000Z'),
    )
    const later = buildRejectedIntent(
      inbound,
      routing,
      ['FLYWHEEL_COMM_DB'],
      new Date('2026-08-11T05:00:02.000Z'),
    )
    const conflict = buildRejectedIntent(
      { ...inbound, text: 'different' },
      routing,
      ['FLYWHEEL_COMM_DB'],
      new Date('2026-08-11T05:00:03.000Z'),
    )
    const path = join(dir, 'chat-receipt-spool', 'rejected', `${begin.messageId}.json`)

    expect(await runtime.holdInbound(first)).toBe('rejected')
    const original = readFileSync(path, 'utf8')
    expect(await runtime.holdInbound(later)).toBe('rejected')
    expect(await runtime.holdInbound(conflict)).toBe('rejected')
    expect(readFileSync(path, 'utf8')).toBe(original)
    expect(logs.filter(line => line.includes('discord_mailbox_rejected_duplicate'))).toHaveLength(1)
    expect(logs.filter(line => line.includes('discord_mailbox_rejected_conflict'))).toHaveLength(1)
    expect(readdirSync(join(dir, 'chat-receipt-spool', 'rejected'))
      .filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('never falls back to legacy and removes a partial rejected temp file', async () => {
    const dir = tempDir()
    const logs: string[] = []
    const runtime = new ChatIngestRuntime({
      mode: { kind: 'broken', missing: ['FLYWHEEL_COMM_DB'] },
      stateDir: dir,
      log: line => logs.push(line),
      writeRejectedTemp: (path, encoded) => {
        writeFileSync(path, encoded.slice(0, 10), { flag: 'wx' })
        throw new Error('disk full')
      },
    })

    expect(await runtime.holdInbound(buildRejectedIntent(
      inbound,
      routing,
      ['FLYWHEEL_COMM_DB'],
      new Date('2026-08-11T05:00:01.000Z'),
    ))).toBe('rejected')
    const rejectedDir = join(dir, 'chat-receipt-spool', 'rejected')
    expect(readdirSync(rejectedDir).filter(name => name.endsWith('.tmp'))).toEqual([])
    expect(logs.filter(line => line.includes('discord_mailbox_rejected_write_failed'))).toHaveLength(1)
  })

  it('remains rejected when the injected persistence writer fails', async () => {
    const logs: string[] = []
    const runtime = new ChatIngestRuntime({
      mode: { kind: 'broken', missing: ['FLYWHEEL_COMM_DB'] },
      stateDir: tempDir(),
      log: line => logs.push(line),
      writeRejectedIntent: () => { throw new Error('disk full') },
    })
    expect(await runtime.holdInbound(rejectedIntent(begin.messageId))).toBe('rejected')
    expect(logs.filter(line => line.includes('discord_mailbox_rejected_write_failed'))).toHaveLength(1)
  })

  it('replays rejected messages in id order with held and stale flags', async () => {
    const dir = tempDir()
    for (const intent of [
      rejectedIntent('100000000000000013'),
      rejectedIntent(
        '100000000000000011',
        '2026-08-12T05:00:00.000Z',
        '2026-08-11T03:59:59.000Z',
      ),
      rejectedIntent('100000000000000012'),
    ]) writeRejected(dir, intent)
    const commands: string[][] = []
    const runtime = new ChatIngestRuntime({
      mode: enabledMode(),
      stateDir: dir,
      now: () => new Date('2026-08-12T05:00:00.000Z'),
      runCommand: async argv => {
        commands.push(argv)
        return argv.includes('--version-probe')
          ? result(JSON.stringify({ protocolVersion: 2 }))
          : result(JSON.stringify({ lane: 'active_inbox' }))
      },
    })

    runtime.kickWorker()
    await runtime.whenIdle()
    const ingests = commands.filter(argv => !argv.includes('--version-probe'))
    expect(ingests.map(argv => argv[argv.indexOf('--message-id') + 1])).toEqual([
      '100000000000000011',
      '100000000000000012',
      '100000000000000013',
    ])
    for (const argv of ingests) {
      expect(argv).toContain('--held-since')
      expect(argv).toContain('--held-reason')
      expect(argv).toContain('discord_wiring_broken')
    }
    expect(ingests[0]).toContain('--dead-letter-reason')
    expect(ingests[1]).not.toContain('--dead-letter-reason')
    expect(ingests[2]).not.toContain('--dead-letter-reason')
    expect(readdirSync(join(dir, 'chat-receipt-spool', 'rejected'))).toEqual([])
  })

  it('backs off an old CLI capability and self-heals without restart', async () => {
    const dir = tempDir()
    const path = writeRejected(dir, rejectedIntent(begin.messageId))
    const commands: string[][] = []
    const timers: Array<{ fn: () => void; ms: number }> = []
    const logs: string[] = []
    let now = new Date('2026-08-11T05:00:01.000Z')
    let protocolVersion = 1
    const runtime = new ChatIngestRuntime({
      mode: enabledMode(),
      stateDir: dir,
      now: () => now,
      log: line => logs.push(line),
      runCommand: async argv => {
        commands.push(argv)
        return argv.includes('--version-probe')
          ? result(JSON.stringify({ protocolVersion }))
          : result(JSON.stringify({ lane: 'inserted_inbox' }))
      },
      setTimer: (fn, ms) => {
        timers.push({ fn, ms })
        return timers.length as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    runtime.kickWorker()
    await runtime.whenIdle()
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain('--version-probe')
    expect(existsSync(path)).toBe(true)
    expect(timers).toHaveLength(1)
    expect(timers[0]!.ms).toBeGreaterThanOrEqual(5_000)
    expect(logs.filter(line => line.includes('discord_mailbox_replay_awaiting_cli'))).toHaveLength(1)

    protocolVersion = 2
    now = new Date('2026-08-11T05:00:06.000Z')
    timers[0]!.fn()
    await runtime.whenIdle()
    expect(commands.filter(argv => argv.includes('--version-probe'))).toHaveLength(2)
    expect(commands.filter(argv => !argv.includes('--version-probe'))).toHaveLength(1)
    expect(existsSync(path)).toBe(false)
  })

  it('keeps a head-of-line barrier and one bounded retry timer', async () => {
    const dir = tempDir()
    const first = writeRejected(dir, rejectedIntent('100000000000000011'))
    const second = writeRejected(dir, rejectedIntent('100000000000000012'))
    const ingested: string[] = []
    const timers: number[] = []
    const runtime = new ChatIngestRuntime({
      mode: enabledMode(),
      stateDir: dir,
      now: () => new Date('2026-08-11T05:00:01.000Z'),
      runCommand: async argv => {
        if (argv.includes('--version-probe')) {
          return result(JSON.stringify({ protocolVersion: 2 }))
        }
        ingested.push(argv[argv.indexOf('--message-id') + 1]!)
        return result('', 1, 'mailbox unavailable')
      },
      setTimer: (_fn, ms) => {
        timers.push(ms)
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    runtime.kickWorker()
    await runtime.whenIdle()
    expect(ingested).toEqual(['100000000000000011'])
    expect(JSON.parse(readFileSync(first, 'utf8')).attempts).toBe(1)
    expect(existsSync(second)).toBe(true)
    expect(timers).toEqual([5_000])
  })

  it('does not let a due successor bypass a backed-off head', async () => {
    const dir = tempDir()
    const first = rejectedIntent('100000000000000011')
    first.nextAttemptAt = '2026-08-11T05:00:06.000Z'
    writeRejected(dir, first)
    writeRejected(dir, rejectedIntent('100000000000000012'))
    const ingested: string[] = []
    const timers: number[] = []
    const runtime = new ChatIngestRuntime({
      mode: enabledMode(),
      stateDir: dir,
      now: () => new Date('2026-08-11T05:00:01.000Z'),
      runCommand: async argv => {
        if (argv.includes('--version-probe')) {
          return result(JSON.stringify({ protocolVersion: 2 }))
        }
        ingested.push(argv[argv.indexOf('--message-id') + 1]!)
        return result(JSON.stringify({ lane: 'inserted_inbox' }))
      },
      setTimer: (_fn, ms) => {
        timers.push(ms)
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    runtime.kickWorker()
    await runtime.whenIdle()
    expect(ingested).toEqual([])
    expect(timers).toEqual([5_000])
  })

  it('quarantines a corrupt rejected head and advances to the next message', async () => {
    const dir = tempDir()
    const rejectedDir = join(dir, 'chat-receipt-spool', 'rejected')
    mkdirSync(rejectedDir, { recursive: true })
    const corrupt = join(rejectedDir, '100000000000000011.json')
    writeFileSync(corrupt, '{invalid')
    const valid = writeRejected(dir, rejectedIntent('100000000000000012'))
    const commands: string[][] = []
    const runtime = new ChatIngestRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand: async argv => {
        commands.push(argv)
        return argv.includes('--version-probe')
          ? result(JSON.stringify({ protocolVersion: 2 }))
          : result(JSON.stringify({ lane: 'inserted_inbox' }))
      },
    })

    runtime.kickWorker()
    await runtime.whenIdle()
    expect(existsSync(`${corrupt}.corrupt`)).toBe(true)
    expect(existsSync(valid)).toBe(false)
    expect(commands.filter(argv => !argv.includes('--version-probe'))).toHaveLength(1)
  })

  it('preserves stock and isolated direct delivery', async () => {
    const stock = new ChatIngestRuntime({
      mode: { kind: 'disabled', reason: 'stock' },
      stateDir: tempDir(),
    })
    expect(await stock.holdInbound(undefined)).toBe('legacy')

    const isolated = new ChatIngestRuntime({
      mode: { kind: 'disabled', reason: 'isolated' },
      stateDir: tempDir(),
    })
    expect(await isolated.holdInbound(undefined)).toBe('legacy')
  })
})
