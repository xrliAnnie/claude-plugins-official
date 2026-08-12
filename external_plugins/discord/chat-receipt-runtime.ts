import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  parseSpoolIntent,
  type BeginArgs,
  type RecorderMode,
} from './chat-receipt-recorder'

export interface CommandResult {
  stdout: string
  stderr: string
  exitCode: number
  timedOut: boolean
}

export type RunCommand = (
  argv: string[],
  opts: { stdin?: string; timeoutMs: number },
) => Promise<CommandResult>

export interface IngestIntentV1 {
  v: 1
  begin: BeginArgs
  firstFailedAt: string
  nextAttemptAt: string
  attempts: number
  advisedAt: string | null
}

type DiscordLane =
  | 'inserted_inbox'
  | 'active_inbox'
  | 'inserted_external'
  | 'legacy_external'
  | 'archived'

interface PassResult {
  progress: boolean
  workRemains: boolean
}

export interface ChatIngestRuntimeOptions {
  mode: RecorderMode
  stateDir: string
  runCommand?: RunCommand
  now?: () => Date
  log?: (line: string) => void
  spoolDir?: string
  writeIngestIntent?: (path: string, intent: IngestIntentV1) => void
  founderId?: string
  setTimer?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

const COMMAND_TIMEOUT_MS = 5_000
const INGESTS_PER_PASS = 5
const INGEST_RETRY_INITIAL_MS = 5_000
const INGEST_RETRY_MAX_MS = 5 * 60_000
const INGEST_STALL_LOG_MS = 5 * 60_000

export class ChatIngestRuntime {
  private readonly mode: RecorderMode
  private readonly runCommand: RunCommand
  private readonly now: () => Date
  private readonly log: (line: string) => void
  private readonly spoolDir: string
  private readonly ingestDir: string
  private readonly writeIngestIntent: (path: string, intent: IngestIntentV1) => void
  private readonly founderId?: string
  private readonly setTimer: NonNullable<ChatIngestRuntimeOptions['setTimer']>
  private readonly clearTimer: NonNullable<ChatIngestRuntimeOptions['clearTimer']>
  private ingestWorkerPromise: Promise<void> | undefined
  private ingestDirty = false
  private ingestRetryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(opts: ChatIngestRuntimeOptions) {
    this.mode = opts.mode
    this.runCommand = opts.runCommand ?? runCommand
    this.now = opts.now ?? (() => new Date())
    this.log = opts.log ?? (line => process.stderr.write(`[discord-ingest] ${line}\n`))
    this.spoolDir = opts.spoolDir ?? join(opts.stateDir, 'chat-receipt-spool')
    this.ingestDir = join(this.spoolDir, 'ingest')
    this.writeIngestIntent = opts.writeIngestIntent ?? writeJsonAtomic
    this.founderId = opts.founderId
    this.setTimer = opts.setTimer ?? ((fn, delayMs) => setTimeout(fn, delayMs))
    this.clearTimer = opts.clearTimer ?? (timer => clearTimeout(timer))
  }

  async acceptInbound(args: BeginArgs): Promise<'mailbox' | 'legacy'> {
    if (this.mode.kind !== 'enabled') return 'legacy'
    await this.ingest(args)
    return 'mailbox'
  }

  private async ingest(args: BeginArgs): Promise<void> {
    const path = this.ingestIntentPath(args.messageId)
    let intent = readIngestIntent(path) ?? {
      v: 1 as const,
      begin: args,
      firstFailedAt: this.now().toISOString(),
      nextAttemptAt: this.now().toISOString(),
      attempts: 0,
      advisedAt: null,
    }
    try {
      this.ensureIngestDir()
      this.writeIngestIntent(path, intent)
    } catch (error) {
      this.log(`discord mailbox ingest intent write failed for ${args.messageId}: ${errorText(error)}`)
      const command = await this.invokeIngest(args)
      const lane = parseLaneVerdict(command.stdout)
      if (lane) this.logIngestVerdict(args, lane)
      if (!lane) {
        this.log(JSON.stringify({
          event: 'discord_mailbox_ingest_unrecoverable',
          message_id: args.messageId,
          write_error: errorText(error),
          command_error: command.stderr || command.stdout,
        }))
      }
      return
    }

    for (let attempt = 0; attempt < 2; attempt++) {
      const command = await this.invokeIngest(args)
      const lane = parseLaneVerdict(command.stdout)
      if (lane) {
        this.logIngestVerdict(args, lane)
        rmSync(path, { force: true })
        return
      }
      intent.attempts += 1
    }
    intent = scheduleIngestIntent(intent, this.now())
    try {
      this.writeIngestIntent(path, intent)
    } catch (error) {
      this.log(`discord mailbox ingest retry state write failed for ${args.messageId}: ${errorText(error)}`)
      this.scheduleIngestRetry(INGEST_RETRY_INITIAL_MS)
      return
    }
    this.scheduleIngestRetry()
  }

  async diagnoseNode(): Promise<void> {
    if (this.mode.kind !== 'enabled') return
    try {
      const result = await this.runCommand(['node', '--version'], {
        timeoutMs: COMMAND_TIMEOUT_MS,
      })
      if (!succeeded(result)) {
        this.log(`node preflight failed (durable ingest remains unavailable): ${result.stderr}`)
      }
      const capability = await this.runCommand([
        'node',
        this.mode.commCli,
        'chat-ingest',
        '--version-probe',
        '--json',
      ], { timeoutMs: COMMAND_TIMEOUT_MS })
      if (succeeded(capability)) {
        this.log(JSON.stringify({
          event: 'discord_mailbox_ingest_capability',
          result: capability.stdout.trim(),
        }))
      } else {
        this.log(`chat-ingest capability probe failed: ${capability.stderr || capability.stdout}`)
      }
    } catch (error) {
      this.log(`Discord ingest preflight spawn failed: ${errorText(error)}`)
    }
  }

  kickWorker(): void {
    if (this.mode.kind !== 'enabled') return
    if (this.ingestRetryTimer) this.clearTimer(this.ingestRetryTimer)
    this.ingestRetryTimer = undefined
    this.ingestDirty = true
    if (this.ingestWorkerPromise) return
    const running = this.ingestWorkerLoop()
    this.ingestWorkerPromise = running.finally(() => {
      this.ingestWorkerPromise = undefined
      if (this.ingestDirty) this.kickWorker()
      else this.scheduleIngestRetry()
    })
  }

  async whenIdle(): Promise<void> {
    while (this.ingestWorkerPromise) await this.ingestWorkerPromise
  }

  private async ingestWorkerLoop(): Promise<void> {
    while (true) {
      this.ingestDirty = false
      const pass = await this.drainIngestPass()
      if (!pass.workRemains || (!pass.progress && !this.ingestDirty)) break
    }
  }

  private async drainIngestPass(): Promise<PassResult> {
    let paths = this.listIngestIntentFiles()
    let progress = false
    for (const path of paths.slice(0, INGESTS_PER_PASS)) {
      let intent = readIngestIntent(path)
      if (!intent) {
        try {
          renameSync(path, `${path}.corrupt`)
        } catch (error) {
          this.log(`could not preserve corrupt ingest intent ${basename(path)}: ${errorText(error)}`)
        }
        this.log(JSON.stringify({
          event: 'discord_mailbox_ingest_corrupt_intent',
          intent: basename(path),
        }))
        progress = true
        continue
      }
      if (Date.parse(intent.nextAttemptAt) > this.now().getTime()) continue
      const command = await this.invokeIngest(intent.begin)
      const lane = parseLaneVerdict(command.stdout)
      if (lane) {
        this.logIngestVerdict(intent.begin, lane)
        rmSync(path, { force: true })
        progress = true
        continue
      }
      intent.attempts += 1
      if (
        this.now().getTime() - Date.parse(intent.firstFailedAt) >= INGEST_STALL_LOG_MS &&
        intent.advisedAt === null
      ) {
        intent.advisedAt = this.now().toISOString()
        this.log(JSON.stringify({
          event: 'discord_mailbox_ingest_stalled',
          message_id: intent.begin.messageId,
          attempts: intent.attempts,
        }))
      }
      intent = scheduleIngestIntent(intent, this.now())
      try {
        this.writeIngestIntent(path, intent)
      } catch (error) {
        this.log(`could not update ingest retry state for ${intent.begin.messageId}: ${errorText(error)}`)
        this.scheduleIngestRetry(INGEST_RETRY_INITIAL_MS)
      }
    }
    paths = this.listIngestIntentFiles()
    return { progress, workRemains: paths.length > 0 }
  }

  private async invokeIngest(begin: BeginArgs): Promise<CommandResult> {
    if (this.mode.kind !== 'enabled') return emptySuccess()
    const argv = [
      'node',
      this.mode.commCli,
      'chat-ingest',
      '--db',
      this.mode.dbPath,
      ...ingestFlags(begin, this.founderId),
    ]
    try {
      const command = await this.runCommand(argv, {
        stdin: begin.text,
        timeoutMs: COMMAND_TIMEOUT_MS,
      })
      if (command.timedOut) {
        this.log(`chat-ingest timed out after ${COMMAND_TIMEOUT_MS}ms`)
      }
      return command
    } catch (error) {
      this.log(`chat-ingest spawn failed: ${errorText(error)}`)
      return {
        stdout: '',
        stderr: errorText(error),
        exitCode: 1,
        timedOut: false,
      }
    }
  }

  private logIngestVerdict(begin: BeginArgs, lane: DiscordLane): void {
    this.log(JSON.stringify({
      event: 'discord_mailbox_ingest_verdict',
      message_id: begin.messageId,
      channel_id: begin.originChannelId,
      lane,
    }))
  }

  private ensureIngestDir(): void {
    mkdirSync(this.ingestDir, { recursive: true, mode: 0o700 })
    chmodSync(this.ingestDir, 0o700)
  }

  private ingestIntentPath(messageId: string): string {
    return join(this.ingestDir, `${messageId}.json`)
  }

  private listIngestIntentFiles(): string[] {
    if (!existsSync(this.ingestDir)) return []
    return readdirSync(this.ingestDir)
      .filter(isIntentFilename)
      .map(name => join(this.ingestDir, name))
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
  }

  private scheduleIngestRetry(minDelayMs = 0): void {
    if (this.ingestRetryTimer) return
    const next = this.listIngestIntentFiles()
      .map(readIngestIntent)
      .filter((intent): intent is IngestIntentV1 => intent !== undefined)
      .map(intent => Date.parse(intent.nextAttemptAt))
      .reduce<number | undefined>(
        (earliest, candidate) => earliest === undefined || candidate < earliest
          ? candidate
          : earliest,
        undefined,
      )
    if (next === undefined) return
    const delay = Math.max(minDelayMs, next - this.now().getTime())
    this.ingestRetryTimer = this.setTimer(() => {
      this.ingestRetryTimer = undefined
      this.kickWorker()
    }, delay)
    ;(this.ingestRetryTimer as { unref?: () => void }).unref?.()
  }

}

export async function runCommand(
  argv: string[],
  opts: { stdin?: string; timeoutMs: number },
): Promise<CommandResult> {
  const proc = Bun.spawn(argv, {
    stdin: 'pipe',
    stdout: 'pipe',
    stderr: 'pipe',
    env: process.env,
  })
  const stdoutPromise = new Response(proc.stdout).text()
  const stderrPromise = new Response(proc.stderr).text()
  if (opts.stdin !== undefined) proc.stdin.write(opts.stdin)
  proc.stdin.end()

  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    proc.exited.then(exitCode => ({ exitCode, timedOut: false })),
    new Promise<{ exitCode: number; timedOut: true }>(resolve => {
      timer = setTimeout(() => resolve({ exitCode: 1, timedOut: true }), opts.timeoutMs)
    }),
  ])
  if (timer) clearTimeout(timer)
  if (outcome.timedOut) {
    proc.kill()
    await proc.exited.catch(() => {})
  }
  const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
  return {
    stdout,
    stderr,
    exitCode: outcome.exitCode,
    timedOut: outcome.timedOut,
  }
}

function ingestFlags(begin: BeginArgs, founderId?: string): string[] {
  return [
    '--lead',
    begin.leadId,
    '--chat-id',
    begin.chatId,
    '--origin-channel-id',
    begin.originChannelId,
    '--message-id',
    begin.messageId,
    '--author-id',
    begin.authorId,
    '--author-name',
    begin.authorName,
    ...(founderId ? ['--founder-id', founderId] : []),
    '--reply-channel-id',
    begin.replyChannelId ?? begin.chatId,
    ...(begin.replyRoute
      ? ['--reply-route-json', JSON.stringify(begin.replyRoute)]
      : []),
    '--ts',
    begin.ts,
    '--msg-kind',
    begin.msgKind,
    '--attachments-json',
    JSON.stringify(begin.attachments),
    '--content-stdin',
    '--json',
  ]
}

function succeeded(result: CommandResult): boolean {
  return !result.timedOut && result.exitCode === 0
}

function parseLaneVerdict(stdout: string): DiscordLane | undefined {
  const lanes = new Set<DiscordLane>([
    'inserted_inbox',
    'active_inbox',
    'inserted_external',
    'legacy_external',
    'archived',
  ])
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      const lane = (JSON.parse(line) as { lane?: unknown }).lane
      if (typeof lane === 'string' && lanes.has(lane as DiscordLane)) {
        return lane as DiscordLane
      }
    } catch {}
  }
  return undefined
}

function emptySuccess(): CommandResult {
  return { stdout: '', stderr: '', exitCode: 0, timedOut: false }
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(value), { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(tmp, path)
    chmodSync(path, 0o600)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function readIngestIntent(path: string): IngestIntentV1 | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<IngestIntentV1>
    const begin = parseSpoolIntent(JSON.stringify({
      v: 1,
      begin: parsed.begin,
      attempts: 0,
      advisedAt: null,
    })).begin
    if (
      parsed.v === 1 &&
      typeof parsed.firstFailedAt === 'string' &&
      Number.isFinite(Date.parse(parsed.firstFailedAt)) &&
      typeof parsed.nextAttemptAt === 'string' &&
      Number.isFinite(Date.parse(parsed.nextAttemptAt)) &&
      Number.isSafeInteger(parsed.attempts) &&
      (parsed.attempts as number) >= 0 &&
      (parsed.advisedAt === null || typeof parsed.advisedAt === 'string')
    ) {
      return { ...parsed, begin } as IngestIntentV1
    }
  } catch {}
  return undefined
}

function scheduleIngestIntent(
  intent: IngestIntentV1,
  now: Date,
): IngestIntentV1 {
  const exponent = Math.max(0, intent.attempts - 2)
  const delay = Math.min(
    INGEST_RETRY_INITIAL_MS * (2 ** exponent),
    INGEST_RETRY_MAX_MS,
  )
  return {
    ...intent,
    nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
  }
}

function isIntentFilename(name: string): boolean {
  return /^\d{17,20}\.json$/.test(name)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
