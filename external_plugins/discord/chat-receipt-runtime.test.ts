import { afterEach, describe, expect, it } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ChatReceiptRuntime,
  type CommandResult,
  type RunCommand,
} from './chat-receipt-runtime'
import type { BeginArgs, RecorderMode } from './chat-receipt-recorder'

const tempDirs: string[] = []
afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fly1437-runtime-'))
  tempDirs.push(dir)
  return dir
}

const begin: BeginArgs = {
  leadId: 'flywheel-eng-lead',
  chatId: '100000000000000010',
  originChannelId: '100000000000000010',
  messageId: '100000000000000011',
  authorId: '100000000000000012',
  authorName: 'Annie',
  priority: 0,
  ts: '2026-07-23T05:00:00.000Z',
  msgKind: 'guild',
  attachments: [{ name: 'trace.png', type: 'image/png', sizeKb: 5 }],
  text: 'Please handle this.',
}

function enabledMode(dbPath = join(tempDir(), 'comm.db')): RecorderMode {
  return {
    kind: 'enabled',
    commCli: process.env.FLYWHEEL_COMM_CLI ?? '/missing/flywheel-comm.js',
    dbPath,
    leadId: begin.leadId,
  }
}

function result(stdout = '', exitCode = 0, stderr = ''): CommandResult {
  return { stdout, stderr, exitCode, timedOut: false }
}

function subcommand(argv: string[]): string {
  const marker = argv.indexOf('chat-receipt')
  return argv[marker + 1] ?? ''
}

function pendingRow(overrides: Record<string, unknown> = {}) {
  return {
    seq: 1,
    id: `chat:${begin.leadId}:${begin.messageId}`,
    createdAt: begin.ts,
    envelope: {
      v: 1,
      receiptId: `chat:${begin.leadId}:${begin.messageId}`,
      ...begin,
    },
    ...overrides,
  }
}

describe('real built chat-receipt CLI', () => {
  it('runs begin idempotently, completes delivery, and settles processed_at', async () => {
    const commCli = process.env.FLYWHEEL_COMM_CLI
    if (!commCli || !existsSync(commCli) || !Bun.which('sqlite3')) {
      process.stderr.write(
        'SKIP LOUD: real chat-receipt integration requires FLYWHEEL_COMM_CLI and sqlite3\n',
      )
      return
    }
    const dir = tempDir()
    const dbPath = join(dir, 'comm.db')
    const runtime = new ChatReceiptRuntime({
      mode: {
        kind: 'enabled',
        commCli,
        dbPath,
        leadId: begin.leadId,
      },
      stateDir: dir,
      notify: async () => {},
      advise: async () => {},
    })

    expect(await runtime.begin(begin)).toBe('ok')
    expect(await runtime.begin(begin)).toBe('ok')

    const before = await Bun.$`sqlite3 ${dbPath} "select count(*) from mailbox where id='chat:flywheel-eng-lead:100000000000000011'"`.text()
    expect(before.trim()).toBe('1')

    const priorP0 = process.env.FLYWHEEL_RECEIPT_WINDOW_P0_MIN
    const priorP1 = process.env.FLYWHEEL_RECEIPT_WINDOW_P1_MIN
    process.env.FLYWHEEL_RECEIPT_WINDOW_P0_MIN = '2'
    process.env.FLYWHEEL_RECEIPT_WINDOW_P1_MIN = '30'
    try {
      expect(await runtime.complete(begin.messageId)).toBe(true)
    } finally {
      if (priorP0 === undefined) delete process.env.FLYWHEEL_RECEIPT_WINDOW_P0_MIN
      else process.env.FLYWHEEL_RECEIPT_WINDOW_P0_MIN = priorP0
      if (priorP1 === undefined) delete process.env.FLYWHEEL_RECEIPT_WINDOW_P1_MIN
      else process.env.FLYWHEEL_RECEIPT_WINDOW_P1_MIN = priorP1
    }
    const delivered = await Bun.$`sqlite3 -separator '|' ${dbPath} "select state, acked_at is not null from mailbox where id='chat:flywheel-eng-lead:100000000000000011'"`.text()
    expect(delivered.trim()).toBe('ACKED|1')

    expect(await runtime.settle(begin.messageId, '100000000000000099')).toBe(true)
    const settled = await Bun.$`sqlite3 -separator '|' ${dbPath} "select event, json_extract(row_json, '$.kind'), json_extract(row_json, '$.ref') from mailbox_log where subject_id='chat:flywheel-eng-lead:100000000000000011' and event='processed'"`.text()
    expect(settled.trim()).toBe('processed|discord_explicit_reply|100000000000000099')
  }, 20_000)

  it('runs the ON path through chat-ingest with one inbox row and no direct notification', async () => {
    const commCli = process.env.FLYWHEEL_COMM_CLI
    if (!commCli || !existsSync(commCli) || !Bun.which('sqlite3')) {
      process.stderr.write(
        'SKIP LOUD: real chat-ingest integration requires FLYWHEEL_COMM_CLI and sqlite3\n',
      )
      return
    }
    const dir = tempDir()
    const dbPath = join(dir, 'comm.db')
    let notifications = 0
    const runtime = new ChatReceiptRuntime({
      mode: {
        kind: 'enabled',
        commCli,
        dbPath,
        leadId: begin.leadId,
      },
      stateDir: dir,
      founderId: begin.authorId,
      readMailboxFlag: () => ({ enabled: true }),
      notify: async () => { notifications++ },
      advise: async () => {},
    })

    expect(await runtime.acceptInbound(begin)).toBe('mailbox')
    expect(await runtime.acceptInbound(begin)).toBe('mailbox')
    expect(notifications).toBe(0)
    const row = await Bun.$`sqlite3 -separator '|' ${dbPath} "select count(*), carrier, type, state, from_agent from mailbox where id='chat:flywheel-eng-lead:100000000000000011'"`.text()
    expect(row.trim()).toBe('1|inbox|discord_chat|QUEUED|founder')
  }, 20_000)
})

describe('begin failure and durable spool', () => {
  it('fails open into an atomic 0700/0600 intent and preserves retry state', async () => {
    const dir = tempDir()
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand: async () => result('', 1, 'database unavailable'),
      notify: async () => {},
      advise: async () => {},
    })

    expect(await runtime.begin(begin)).toBe('spooled')
    const spool = join(dir, 'chat-receipt-spool')
    const intent = join(spool, `${begin.messageId}.json`)
    expect(statSync(spool).mode & 0o777).toBe(0o700)
    expect(statSync(intent).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(intent, 'utf8'))).toMatchObject({
      v: 1,
      begin,
      attempts: 0,
      advisedAt: null,
    })
    expect(readdirSync(spool).filter(name => name.endsWith('.tmp'))).toEqual([])
  })

  it('surfaces an immediate advisory when the spool itself cannot be written', async () => {
    const dir = tempDir()
    const spool = join(dir, 'chat-receipt-spool')
    chmodSync(dir, 0o500)
    const advisories: Array<{ chatId?: string; text: string }> = []
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand: async () => result('', 1, 'database unavailable'),
      notify: async () => {},
      advise: async (chatId, text) => {
        advisories.push({ chatId, text })
      },
      spoolDir: spool,
      writeIntent: () => {
        throw new Error('disk full')
      },
    })

    expect(await runtime.begin(begin)).toBe('spool_failed')
    expect(advisories).toEqual([{
      chatId: begin.chatId,
      text: expect.stringContaining('could not persist'),
    }])
  })
})

describe('FLY-1574 mailbox cutover', () => {
  it('uses the OFF direct path only when begin wins the external lane', async () => {
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: tempDir(),
      readMailboxFlag: () => ({ enabled: false }),
      runCommand: async () => result(JSON.stringify({ lane: 'inserted_external' })),
      notify: async () => {},
      advise: async () => {},
    })
    expect(await runtime.acceptInbound(begin)).toBe('legacy')

    const replay = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: tempDir(),
      readMailboxFlag: () => ({ enabled: false }),
      runCommand: async () => result(JSON.stringify({ lane: 'active_inbox' })),
      notify: async () => {},
      advise: async () => {},
    })
    expect(await replay.acceptInbound(begin)).toBe('skip')
  })

  it('writes an isolated ingest intent before the ON CLI and removes it on a verdict', async () => {
    const dir = tempDir()
    const intent = join(dir, 'chat-receipt-spool', 'ingest', `${begin.messageId}.json`)
    const routedBegin: BeginArgs = {
      ...begin,
      replyChannelId: '100000000000000020',
      replyRoute: {
        kind: 'roundtable_thread_from_message',
        parentChannelId: '100000000000000021',
        sourceMessageId: begin.messageId,
        threadId: '100000000000000020',
        threadName: 'mailbox routing',
      },
    }
    let presentDuringCli = false
    const commands: string[][] = []
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: dir,
      readMailboxFlag: () => ({ enabled: true }),
      runCommand: async argv => {
        commands.push(argv)
        presentDuringCli = existsSync(intent)
        return result(JSON.stringify({ lane: 'inserted_inbox' }))
      },
      notify: async () => {},
      advise: async () => {},
    })
    expect(await runtime.acceptInbound(routedBegin)).toBe('mailbox')
    expect(presentDuringCli).toBe(true)
    expect(commands[0]).toContain('chat-ingest')
    expect(commands[0]).toContain('--reply-channel-id')
    expect(commands[0]?.[commands[0].indexOf('--reply-channel-id') + 1]).toBe(
      routedBegin.replyChannelId,
    )
    expect(JSON.parse(
      commands[0]?.[commands[0].indexOf('--reply-route-json') + 1] ?? '',
    )).toEqual(routedBegin.replyRoute)
    expect(existsSync(intent)).toBe(false)
  })

  it('never raw-falls-back on ON ambiguity and schedules one bounded retry', async () => {
    const dir = tempDir()
    const intent = join(dir, 'chat-receipt-spool', 'ingest', `${begin.messageId}.json`)
    const timers: Array<{ fn: () => void; ms: number }> = []
    let now = new Date('2026-08-10T12:00:00.000Z')
    let calls = 0
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: dir,
      readMailboxFlag: () => ({ enabled: true }),
      runCommand: async () => {
        calls++
        return calls <= 2
          ? result('', 1, 'ambiguous')
          : result(JSON.stringify({ lane: 'active_inbox' }))
      },
      notify: async () => {},
      advise: async () => {},
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
    expect(timers[0]!.ms).toBeGreaterThanOrEqual(4_900)
    now = new Date('2026-08-10T12:00:06.000Z')
    timers[0]!.fn()
    await runtime.whenIdle()
    expect(calls).toBe(3)
    expect(existsSync(intent)).toBe(false)
  })

  it('keeps a minimum retry delay when updating the durable schedule fails', async () => {
    const timers: number[] = []
    let writes = 0
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: tempDir(),
      readMailboxFlag: () => ({ enabled: true }),
      writeIngestIntent: (path, intent) => {
        writes++
        if (writes > 1) throw new Error('disk full')
        writeFileSync(path, JSON.stringify(intent))
      },
      runCommand: async () => result('', 1, 'ambiguous'),
      notify: async () => {},
      advise: async () => {},
      setTimer: (_fn, ms) => {
        timers.push(ms)
        return 1 as unknown as ReturnType<typeof setTimeout>
      },
      clearTimer: () => {},
    })

    expect(await runtime.acceptInbound(begin)).toBe('mailbox')
    expect(timers).toEqual([5_000])
  })

  it('alerts when neither the write-ahead intent nor an authoritative CLI verdict is available', async () => {
    const advisories: string[] = []
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: tempDir(),
      readMailboxFlag: () => ({ enabled: true }),
      writeIngestIntent: () => { throw new Error('disk full') },
      runCommand: async () => result('', 1, 'database unavailable'),
      notify: async () => {},
      advise: async (_chatId, text) => { advisories.push(text) },
    })
    expect(await runtime.acceptInbound(begin)).toBe('mailbox')
    expect(advisories).toEqual([expect.stringContaining('manual replay')])
  })
})

describe('broken wiring advisory', () => {
  it('persists detected-before-send and latches only after a successful visible advisory', async () => {
    const dir = tempDir()
    let attempts = 0
    const runtime = new ChatReceiptRuntime({
      mode: { kind: 'broken', missing: ['FLYWHEEL_COMM_DB'] },
      stateDir: dir,
      notify: async () => {},
      advise: async () => {
        attempts++
        if (attempts === 1) throw new Error('Discord unavailable')
      },
      now: () => new Date('2026-07-23T05:00:00.000Z'),
    })

    await runtime.adviseBroken(begin.chatId)
    const marker = join(dir, 'chat-receipt-spool', 'meta', 'broken-advised.json')
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
      detectedAt: '2026-07-23T05:00:00.000Z',
      advisedAt: null,
    })

    await runtime.adviseBroken(begin.chatId)
    await runtime.adviseBroken(begin.chatId)
    expect(attempts).toBe(2)
    expect(JSON.parse(readFileSync(marker, 'utf8'))).toEqual({
      detectedAt: '2026-07-23T05:00:00.000Z',
      advisedAt: '2026-07-23T05:00:00.000Z',
    })
  })
})

describe('producer accept boundary', () => {
  it('marks complete only after the inbound notification has resolved', async () => {
    const dir = tempDir()
    const order: string[] = []
    let releaseNotify: (() => void) | undefined
    const notificationGate = new Promise<void>(resolve => {
      releaseNotify = resolve
    })
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand: async argv => {
        order.push(subcommand(argv))
        return result('{}')
      },
      notify: async () => {
        order.push('notify-start')
        await notificationGate
        order.push('notify-done')
      },
      advise: async () => {},
    })

    const delivery = runtime.deliver(begin)
    await Promise.resolve()
    expect(order).toEqual(['notify-start'])
    releaseNotify?.()
    expect(await delivery).toBe(true)
    expect(order).toEqual(['notify-start', 'notify-done', 'complete'])
  })

  it('does not complete when notification delivery rejects', async () => {
    const commands: string[] = []
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: tempDir(),
      runCommand: async argv => {
        commands.push(subcommand(argv))
        return result('{}')
      },
      notify: async () => {
        throw new Error('MCP closed')
      },
      advise: async () => {},
    })

    expect(await runtime.deliver(begin)).toBe(false)
    expect(commands).toEqual([])
  })
})

describe('recovery worker', () => {
  it('does not turn a successful settle into reply failure when the intent path is unusable', async () => {
    const dir = tempDir()
    mkdirSync(join(
      dir,
      'chat-receipt-spool',
      'settle',
      `${begin.messageId}.json`,
    ), { recursive: true })
    const logs: string[] = []
    const advisories: string[] = []
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand: async () => result('{}'),
      notify: async () => {},
      advise: async (_chatId, text) => {
        advisories.push(text)
      },
      log: line => logs.push(line),
    })

    expect(await runtime.settle(
      begin.messageId,
      '100000000000000099',
      begin.chatId,
    )).toBe(true)
    expect(logs).toEqual([
      expect.stringContaining('settle recovery write failed'),
      expect.stringContaining('could not remove stale settle intent'),
    ])
    expect(advisories).toEqual([
      expect.stringContaining('could not persist its recovery intent'),
    ])
  })

  it('persists the settle proof before the CLI runs (write-ahead)', async () => {
    const dir = tempDir()
    const settlePath = join(
      dir,
      'chat-receipt-spool',
      'settle',
      `${begin.messageId}.json`,
    )
    let intentDuringCli: boolean | null = null
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand: async argv => {
        if (subcommand(argv) === 'settle') {
          // Snapshot durability at the moment the CLI starts: a crash while the
          // CLI is in flight must already find the proof on disk.
          intentDuringCli = existsSync(settlePath)
          return result('{}')
        }
        if (subcommand(argv) === 'pending') {
          return result(JSON.stringify({ rows: [], nextCursor: 0 }))
        }
        return result('{}')
      },
      notify: async () => {},
      advise: async () => {},
      sleep: async () => {},
    })

    expect(await runtime.settle(
      begin.messageId,
      '100000000000000099',
      begin.chatId,
    )).toBe(true)
    expect(intentDuringCli).toBe(true)
    expect(existsSync(settlePath)).toBe(false)
  })

  it('persists a failed settle proof and recovers it after process restart', async () => {
    const dir = tempDir()
    let settleCalls = 0
    const failingRuntime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand: async argv => {
        if (subcommand(argv) === 'settle') {
          settleCalls++
          return result('', 1, 'database busy')
        }
        if (subcommand(argv) === 'pending') {
          return result(JSON.stringify({ rows: [], nextCursor: 0 }))
        }
        return result('{}')
      },
      notify: async () => {},
      advise: async () => {},
      sleep: async () => {},
    })

    expect(await failingRuntime.settle(
      begin.messageId,
      '100000000000000099',
      begin.chatId,
    )).toBe(false)
    await failingRuntime.whenIdle()

    expect(settleCalls).toBe(2)
    const settleDir = join(dir, 'chat-receipt-spool', 'settle')
    const settlePath = join(
      settleDir,
      `${begin.messageId}.json`,
    )
    expect(statSync(settleDir).mode & 0o777).toBe(0o700)
    expect(statSync(settlePath).mode & 0o777).toBe(0o600)
    expect(JSON.parse(readFileSync(settlePath, 'utf8'))).toMatchObject({
      v: 1,
      messageId: begin.messageId,
      replyId: '100000000000000099',
      chatId: begin.chatId,
      attempts: 1,
      advisedAt: null,
    })

    const restartedRuntime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand: async argv => {
        if (subcommand(argv) === 'settle') {
          settleCalls++
          return result('{}')
        }
        if (subcommand(argv) === 'pending') {
          return result(JSON.stringify({ rows: [], nextCursor: 0 }))
        }
        return result('{}')
      },
      notify: async () => {},
      advise: async () => {},
      sleep: async () => {},
    })
    restartedRuntime.kickWorker()
    await restartedRuntime.whenIdle()

    expect(settleCalls).toBe(3)
    expect(existsSync(join(
      dir,
      'chat-receipt-spool',
      'settle',
      `${begin.messageId}.json`,
    ))).toBe(false)
  })

  it('drains a failed begin idempotently without completing it directly', async () => {
    const dir = tempDir()
    let healthy = false
    const commands: string[] = []
    const runCommand: RunCommand = async argv => {
      const sub = subcommand(argv)
      commands.push(sub)
      if (sub === 'begin') return healthy ? result('{}') : result('', 1, 'down')
      if (sub === 'pending') return result(JSON.stringify({ rows: [], nextCursor: 0 }))
      return result('{}')
    }
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand,
      notify: async () => {},
      advise: async () => {},
      sleep: async () => {},
    })

    expect(await runtime.begin(begin)).toBe('spooled')
    healthy = true
    runtime.kickWorker()
    await runtime.whenIdle()

    expect(commands.filter(command => command === 'begin')).toHaveLength(2)
    expect(commands).not.toContain('complete')
    expect(existsSync(join(dir, 'chat-receipt-spool', `${begin.messageId}.json`))).toBe(false)
  })

  it('skips active accepts, then redelivers and completes after the accept releases', async () => {
    const dir = tempDir()
    let delivered = false
    const notifications: string[] = []
    const commands: string[] = []
    const runCommand: RunCommand = async argv => {
      const sub = subcommand(argv)
      commands.push(sub)
      if (sub === 'pending') {
        return result(JSON.stringify({
          rows: delivered ? [] : [pendingRow()],
          nextCursor: 1,
        }))
      }
      if (sub === 'complete') {
        delivered = true
        return result('{}')
      }
      return result('{}')
    }
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand,
      notify: async notification => {
        notifications.push(notification.content)
      },
      advise: async () => {},
      sleep: async () => {},
    })

    runtime.markAccepting(begin.messageId)
    runtime.kickWorker()
    await runtime.whenIdle()
    expect(notifications).toEqual([])

    runtime.finishAccepting(begin.messageId)
    runtime.kickWorker()
    await runtime.whenIdle()
    expect(notifications).toEqual([`[redelivery] ${begin.text}`])
    expect(commands).toContain('complete')
  })

  it('quarantines a 48h-old row before notify and completes only after notify resolves', async () => {
    const dir = tempDir()
    const order: string[] = []
    let delivered = false
    const old = {
      ...begin,
      ts: '2026-07-20T00:00:00.000Z',
    }
    const runCommand: RunCommand = async argv => {
      const sub = subcommand(argv)
      if (sub === 'pending') {
        return result(JSON.stringify({
          rows: delivered ? [] : [pendingRow({
            createdAt: old.ts,
            envelope: {
              v: 1,
              receiptId: `chat:${begin.leadId}:${begin.messageId}`,
              ...old,
            },
          })],
          nextCursor: 1,
        }))
      }
      order.push(sub)
      if (sub === 'complete') delivered = true
      return result('{}')
    }
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand,
      notify: async () => {
        order.push('notify')
      },
      advise: async () => {},
      now: () => new Date('2026-07-23T05:00:00.000Z'),
      sleep: async () => {},
    })

    runtime.kickWorker()
    await runtime.whenIdle()
    expect(order).toEqual(['quarantine', 'notify', 'complete'])
  })

  it('coalesces kicks and continues across a five-intent pass until finite work is empty', async () => {
    const dir = tempDir()
    let healthy = false
    let beginCalls = 0
    let pendingCalls = 0
    const runCommand: RunCommand = async argv => {
      const sub = subcommand(argv)
      if (sub === 'begin') {
        beginCalls++
        return healthy ? result('{}') : result('', 1, 'down')
      }
      if (sub === 'pending') {
        pendingCalls++
        return result(JSON.stringify({ rows: [], nextCursor: 0 }))
      }
      return result('{}')
    }
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand,
      notify: async () => {},
      advise: async () => {},
      sleep: async () => {},
    })
    for (let i = 0; i < 12; i++) {
      const messageId = String(100000000000000100n + BigInt(i))
      await runtime.begin({ ...begin, messageId })
    }

    healthy = true
    runtime.kickWorker()
    runtime.kickWorker()
    runtime.kickWorker()
    await runtime.whenIdle()

    expect(readdirSync(join(dir, 'chat-receipt-spool')).filter(name => name.endsWith('.json'))).toEqual([])
    expect(beginCalls).toBe(24)
    expect(pendingCalls).toBeLessThanOrEqual(4)
  })

  it('preserves a kick that lands during a zero-work pass and drains the new intent', async () => {
    const dir = tempDir()
    let healthy = false
    let beginCalls = 0
    let releasePending: (() => void) | undefined
    let announcePending: (() => void) | undefined
    const pendingStarted = new Promise<void>(resolve => {
      announcePending = resolve
    })
    const pendingGate = new Promise<void>(resolve => {
      releasePending = resolve
    })
    let firstPending = true
    const runCommand: RunCommand = async argv => {
      const sub = subcommand(argv)
      if (sub === 'begin') {
        beginCalls++
        return healthy ? result('{}') : result('', 1, 'down')
      }
      if (sub === 'pending') {
        if (firstPending) {
          firstPending = false
          announcePending?.()
          await pendingGate
        }
        return result(JSON.stringify({ rows: [], nextCursor: 0 }))
      }
      return result('{}')
    }
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand,
      notify: async () => {},
      advise: async () => {},
      sleep: async () => {},
    })

    runtime.kickWorker()
    await pendingStarted
    expect(await runtime.begin(begin)).toBe('spooled')
    healthy = true
    runtime.kickWorker()
    releasePending?.()
    await runtime.whenIdle()

    expect(beginCalls).toBe(2)
    expect(existsSync(join(dir, 'chat-receipt-spool', `${begin.messageId}.json`))).toBe(false)
  })

  it('preserves corrupt intents, ignores metadata filenames, and retries the pending advisory', async () => {
    const dir = tempDir()
    const spool = join(dir, 'chat-receipt-spool')
    mkdirSync(spool, { recursive: true })
    const intent = join(spool, `${begin.messageId}.json`)
    const unrelated = join(spool, 'depth-advised.json')
    writeFileSync(intent, '{"v":1,"begin":')
    writeFileSync(unrelated, 'operator-owned')
    let advisoryAttempts = 0
    const runtime = new ChatReceiptRuntime({
      mode: enabledMode(),
      stateDir: dir,
      runCommand: async argv => {
        if (subcommand(argv) === 'pending') {
          return result(JSON.stringify({ rows: [], nextCursor: 0 }))
        }
        return result('{}')
      },
      notify: async () => {},
      advise: async () => {
        advisoryAttempts++
        if (advisoryAttempts === 1) throw new Error('Discord unavailable')
      },
      now: () => new Date('2026-07-23T05:00:00.000Z'),
      sleep: async () => {},
    })

    runtime.markAccepting(begin.messageId)
    runtime.finishAccepting(begin.messageId)
    await runtime.begin({ ...begin, messageId: '100000000000000099' })
    runtime.kickWorker()
    await runtime.whenIdle()
    expect(existsSync(`${intent}.corrupt`)).toBe(true)
    expect(readFileSync(unrelated, 'utf8')).toBe('operator-owned')
    expect(JSON.parse(readFileSync(join(spool, 'meta', 'corrupt-advised.json'), 'utf8'))).toMatchObject({
      advisedAt: null,
    })

    runtime.kickWorker()
    await runtime.whenIdle()
    expect(advisoryAttempts).toBe(2)
    expect(JSON.parse(readFileSync(join(spool, 'meta', 'corrupt-advised.json'), 'utf8'))).toMatchObject({
      advisedAt: '2026-07-23T05:00:00.000Z',
    })
  })
})
