import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ChatIngestRuntime,
  type CommandResult,
} from './chat-receipt-runtime'
import type { BeginArgs, RecorderMode } from './chat-receipt-recorder'

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
    expect(serverSource).toMatch(
      /await chatIngestRuntime\.acceptInbound\(ingestArgs\)[\s\S]{0,120}chatIngestRuntime\.kickWorker\(\)/,
    )
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

  it('preserves stock and broken-wiring direct delivery', async () => {
    const stock = new ChatIngestRuntime({
      mode: { kind: 'disabled', reason: 'stock' },
      stateDir: tempDir(),
    })
    expect(await stock.acceptInbound(begin)).toBe('legacy')

    const broken = new ChatIngestRuntime({
      mode: { kind: 'broken', missing: ['FLYWHEEL_COMM_DB'] },
      stateDir: tempDir(),
    })
    expect(await broken.acceptInbound(begin)).toBe('legacy')
  })
})
