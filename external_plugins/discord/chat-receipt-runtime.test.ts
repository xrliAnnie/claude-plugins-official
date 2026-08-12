import { afterEach, describe, expect, it } from 'bun:test'
import {
  existsSync,
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
  it('always invokes chat-ingest and never invokes a receipt command', async () => {
    const commands: string[][] = []
    const runtime = new ChatIngestRuntime({
      mode: enabledMode(),
      stateDir: tempDir(),
      runCommand: async argv => {
        commands.push(argv)
        return result(JSON.stringify({ lane: 'inserted_inbox' }))
      },
      advise: async () => {},
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
      advise: async () => {},
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

  it('preserves stock direct delivery and latches broken-wiring advice', async () => {
    const stock = new ChatIngestRuntime({
      mode: { kind: 'disabled', reason: 'stock' },
      stateDir: tempDir(),
      advise: async () => {},
    })
    expect(await stock.acceptInbound(begin)).toBe('legacy')

    const dir = tempDir()
    let attempts = 0
    const broken = new ChatIngestRuntime({
      mode: { kind: 'broken', missing: ['FLYWHEEL_COMM_DB'] },
      stateDir: dir,
      advise: async () => { attempts++ },
      now: () => new Date('2026-08-11T05:00:00.000Z'),
    })
    await broken.adviseBroken(begin.chatId)
    await broken.adviseBroken(begin.chatId)
    expect(attempts).toBe(1)
    expect(JSON.parse(readFileSync(
      join(dir, 'chat-receipt-spool', 'meta', 'broken-advised.json'),
      'utf8',
    ))).toEqual({
      detectedAt: '2026-08-11T05:00:00.000Z',
      advisedAt: '2026-08-11T05:00:00.000Z',
    })
  })
})
