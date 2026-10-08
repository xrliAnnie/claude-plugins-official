import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  linkSync,
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
  buildBeginArgs,
  parseRejectedIntent,
  parseSpoolIntent,
  type BeginArgs,
  type RecorderMode,
  type RejectedIntentV1,
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
  writeRejectedIntent?: (path: string, intent: RejectedIntentV1) => 'created' | 'exists'
  writeRejectedTemp?: (path: string, encoded: string) => void
  founderId?: string
  setTimer?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

const COMMAND_TIMEOUT_MS = 5_000
const INGESTS_PER_PASS = 5
const INGEST_RETRY_INITIAL_MS = 5_000
const INGEST_RETRY_MAX_MS = 5 * 60_000
const INGEST_STALL_LOG_MS = 5 * 60_000
const CAPABILITY_RETRY_INITIAL_MS = 5_000
const CAPABILITY_RETRY_MAX_MS = 5 * 60_000
const REJECTED_STALE_AFTER_MS = 24 * 60 * 60_000

export class ChatIngestRuntime {
  private readonly mode: RecorderMode
  private readonly runCommand: RunCommand
  private readonly now: () => Date
  private readonly log: (line: string) => void
  private readonly spoolDir: string
  private readonly ingestDir: string
  private readonly rejectedDir: string
  private readonly writeIngestIntent: (path: string, intent: IngestIntentV1) => void
  private readonly writeRejectedIntent: (
    path: string,
    intent: RejectedIntentV1,
  ) => 'created' | 'exists'
  private readonly founderId?: string
  private readonly setTimer: NonNullable<ChatIngestRuntimeOptions['setTimer']>
  private readonly clearTimer: NonNullable<ChatIngestRuntimeOptions['clearTimer']>
  private ingestWorkerPromise: Promise<void> | undefined
  private ingestDirty = false
  private ingestRetryTimer: ReturnType<typeof setTimeout> | undefined
  private capability: {
    protocolVersion?: number
    retryAt: number
    failures: number
    awaitingLogged: boolean
  } = { retryAt: 0, failures: 0, awaitingLogged: false }

  constructor(opts: ChatIngestRuntimeOptions) {
    this.mode = opts.mode
    this.runCommand = opts.runCommand ?? runCommand
    this.now = opts.now ?? (() => new Date())
    this.log = opts.log ?? (line => process.stderr.write(`[discord-ingest] ${line}\n`))
    this.spoolDir = opts.spoolDir ?? join(opts.stateDir, 'chat-receipt-spool')
    this.ingestDir = join(this.spoolDir, 'ingest')
    this.rejectedDir = join(this.spoolDir, 'rejected')
    this.writeIngestIntent = opts.writeIngestIntent ?? writeJsonAtomic
    this.writeRejectedIntent = opts.writeRejectedIntent ?? ((path, intent) =>
      writeJsonCreateOnly(path, intent, opts.writeRejectedTemp))
    this.founderId = opts.founderId
    this.setTimer = opts.setTimer ?? ((fn, delayMs) => setTimeout(fn, delayMs))
    this.clearTimer = opts.clearTimer ?? (timer => clearTimeout(timer))
  }

  async acceptInbound(args: BeginArgs): Promise<'mailbox' | 'legacy'> {
    if (this.mode.kind !== 'enabled') return 'legacy'
    await this.ingest(args)
    return 'mailbox'
  }

  async holdInbound(
    intent: RejectedIntentV1 | undefined,
  ): Promise<'rejected' | 'legacy'> {
    if (this.mode.kind !== 'broken') return 'legacy'
    if (!intent) {
      this.log(JSON.stringify({
        event: 'discord_mailbox_rejected_write_failed',
        error: 'rejected intent is missing',
      }))
      return 'rejected'
    }
    const path = this.rejectedIntentPath(intent.inbound.messageId)
    try {
      this.ensureRejectedDir()
      const outcome = this.writeRejectedIntent(path, intent)
      if (outcome === 'created') {
        this.log(JSON.stringify({
          event: 'discord_mailbox_inbound_rejected',
          message_id: intent.inbound.messageId,
          channel_id: intent.inbound.originChannelId,
          missing: intent.missing,
        }))
      } else {
        const existing = readRejectedIntent(path)
        const duplicate = existing !== undefined && rejectedPayload(existing) === rejectedPayload(intent)
        this.log(JSON.stringify({
          event: duplicate
            ? 'discord_mailbox_rejected_duplicate'
            : 'discord_mailbox_rejected_conflict',
          message_id: intent.inbound.messageId,
          channel_id: intent.inbound.originChannelId,
        }))
      }
    } catch (error) {
      this.log(JSON.stringify({
        event: 'discord_mailbox_rejected_write_failed',
        message_id: intent.inbound.messageId,
        channel_id: intent.inbound.originChannelId,
        error: errorText(error),
      }))
    }
    return 'rejected'
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
    intent = scheduleRetryIntent(intent, this.now())
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
      const replay = await this.replayRejectedPass()
      const ingest = await this.drainIngestPass()
      const pass = {
        progress: replay.progress || ingest.progress,
        workRemains: replay.workRemains || ingest.workRemains,
      }
      if (!pass.workRemains || (!pass.progress && !this.ingestDirty)) break
    }
  }

  private async replayRejectedPass(): Promise<PassResult> {
    if (this.mode.kind !== 'enabled') return { progress: false, workRemains: false }
    let paths = this.listRejectedIntentFiles()
    if (paths.length === 0) return { progress: false, workRemains: false }
    if (!(await this.ensureReplayCapability())) {
      return { progress: false, workRemains: false }
    }

    const mode = this.mode
    let progress = false
    for (const path of paths.slice(0, INGESTS_PER_PASS)) {
      let intent = readRejectedIntent(path)
      if (!intent) {
        try {
          renameSync(path, `${path}.corrupt`)
          this.log(JSON.stringify({
            event: 'discord_mailbox_replay_corrupt_intent',
            intent: basename(path),
          }))
          progress = true
          continue
        } catch (error) {
          this.log(`could not preserve corrupt rejected intent ${basename(path)}: ${errorText(error)}`)
          break
        }
      }
      const now = this.now()
      if (Date.parse(intent.nextAttemptAt) > now.getTime()) break
      const begin = buildBeginArgs(
        intent.inbound,
        { ...intent.routing, leadId: mode.leadId },
        this.founderId,
      )
      const stale = now.getTime() - Date.parse(intent.inbound.ts) > REJECTED_STALE_AFTER_MS
      const command = await this.invokeIngest(begin, [
        '--held-since',
        intent.receivedAt,
        '--held-reason',
        'discord_wiring_broken',
        ...(stale
          ? ['--dead-letter-reason', 'discord_wiring_broken_stale']
          : []),
      ])
      const lane = parseLaneVerdict(command.stdout)
      if (lane) {
        this.log(JSON.stringify({
          event: 'discord_mailbox_replay_verdict',
          message_id: intent.inbound.messageId,
          lane,
          stale,
          held_since: intent.receivedAt,
        }))
        rmSync(path, { force: true })
        progress = true
        continue
      }

      intent.attempts += 1
      if (
        now.getTime() - Date.parse(intent.receivedAt) >= INGEST_STALL_LOG_MS &&
        intent.advisedAt === null
      ) {
        intent.advisedAt = now.toISOString()
        this.log(JSON.stringify({
          event: 'discord_mailbox_replay_stalled',
          message_id: intent.inbound.messageId,
          attempts: intent.attempts,
        }))
      }
      intent = scheduleRetryIntent(intent, now)
      try {
        writeJsonAtomic(path, intent)
      } catch (error) {
        this.log(`could not update rejected retry state for ${intent.inbound.messageId}: ${errorText(error)}`)
        this.scheduleIngestRetry(INGEST_RETRY_INITIAL_MS)
      }
      break
    }
    paths = this.listRejectedIntentFiles()
    return { progress, workRemains: paths.length > 0 }
  }

  private async ensureReplayCapability(): Promise<boolean> {
    if (this.capability.protocolVersion !== undefined && this.capability.protocolVersion >= 2) {
      return true
    }
    const now = this.now().getTime()
    if (now < this.capability.retryAt) return false
    let protocolVersion: number | undefined
    try {
      const result = await this.runCommand([
        'node',
        (this.mode as Extract<RecorderMode, { kind: 'enabled' }>).commCli,
        'chat-ingest',
        '--version-probe',
        '--json',
      ], { timeoutMs: COMMAND_TIMEOUT_MS })
      if (succeeded(result)) protocolVersion = parseProtocolVersion(result.stdout)
    } catch {}
    if (protocolVersion !== undefined && protocolVersion >= 2) {
      this.capability = {
        protocolVersion,
        retryAt: 0,
        failures: 0,
        awaitingLogged: false,
      }
      return true
    }

    this.capability.failures += 1
    this.capability.retryAt = now + Math.min(
      CAPABILITY_RETRY_INITIAL_MS * (2 ** (this.capability.failures - 1)),
      CAPABILITY_RETRY_MAX_MS,
    )
    if (!this.capability.awaitingLogged) {
      this.capability.awaitingLogged = true
      this.log(JSON.stringify({
        event: 'discord_mailbox_replay_awaiting_cli',
        protocol_version: protocolVersion ?? null,
        retry_at: new Date(this.capability.retryAt).toISOString(),
      }))
    }
    return false
  }

  private async drainIngestPass(): Promise<PassResult> {
    let paths = this.listIngestIntentFiles()
    let progress = false
    for (const path of paths.slice(0, INGESTS_PER_PASS)) {
      let intent = readIngestIntent(path)
      if (!intent) {
        let preserved = false
        try {
          renameSync(path, `${path}.corrupt`)
          preserved = true
        } catch (error) {
          this.log(`could not preserve corrupt ingest intent ${basename(path)}: ${errorText(error)}`)
        }
        if (preserved) {
          this.log(JSON.stringify({
            event: 'discord_mailbox_ingest_corrupt_intent',
            intent: basename(path),
          }))
          progress = true
        }
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
      intent = scheduleRetryIntent(intent, this.now())
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

  private async invokeIngest(
    begin: BeginArgs,
    extraFlags: string[] = [],
  ): Promise<CommandResult> {
    if (this.mode.kind !== 'enabled') return emptySuccess()
    const argv = [
      'node',
      this.mode.commCli,
      'chat-ingest',
      '--db',
      this.mode.dbPath,
      ...ingestFlags(begin, this.founderId),
      ...extraFlags,
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

  private ensureRejectedDir(): void {
    mkdirSync(this.rejectedDir, { recursive: true, mode: 0o700 })
    chmodSync(this.rejectedDir, 0o700)
  }

  private ingestIntentPath(messageId: string): string {
    return join(this.ingestDir, `${messageId}.json`)
  }

  private rejectedIntentPath(messageId: string): string {
    return join(this.rejectedDir, `${messageId}.json`)
  }

  private listIngestIntentFiles(): string[] {
    if (!existsSync(this.ingestDir)) return []
    return readdirSync(this.ingestDir)
      .filter(isIntentFilename)
      .map(name => join(this.ingestDir, name))
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
  }

  private listRejectedIntentFiles(): string[] {
    if (!existsSync(this.rejectedDir)) return []
    return readdirSync(this.rejectedDir)
      .filter(isIntentFilename)
      .map(name => join(this.rejectedDir, name))
      .sort((a, b) => {
        const left = BigInt(basename(a, '.json'))
        const right = BigInt(basename(b, '.json'))
        return left < right ? -1 : left > right ? 1 : 0
      })
  }

  private scheduleIngestRetry(minDelayMs = 0): void {
    if (this.ingestRetryTimer) return
    const candidates = this.listIngestIntentFiles()
      .map(readIngestIntent)
      .filter((intent): intent is IngestIntentV1 => intent !== undefined)
      .map(intent => Date.parse(intent.nextAttemptAt))
    const rejectedHead = this.listRejectedIntentFiles()[0]
    const rejectedIntent = rejectedHead ? readRejectedIntent(rejectedHead) : undefined
    if (rejectedIntent) {
      candidates.push(Math.max(
        Date.parse(rejectedIntent.nextAttemptAt),
        this.capability.retryAt,
      ))
    }
    const next = candidates
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

function writeJsonCreateOnly(
  path: string,
  value: unknown,
  writeTemp = (tmp: string, encoded: string) => writeFileSync(
    tmp,
    encoded,
    { encoding: 'utf8', mode: 0o600, flag: 'wx' },
  ),
): 'created' | 'exists' {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeTemp(tmp, JSON.stringify(value))
    try {
      linkSync(tmp, path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return 'exists'
      throw error
    }
    chmodSync(path, 0o600)
    return 'created'
  } finally {
    rmSync(tmp, { force: true })
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

function readRejectedIntent(path: string): RejectedIntentV1 | undefined {
  try {
    return parseRejectedIntent(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

function rejectedPayload(intent: RejectedIntentV1): string {
  return JSON.stringify({
    inbound: intent.inbound,
    routing: intent.routing,
    missing: intent.missing,
  })
}

function scheduleRetryIntent<T extends IngestIntentV1 | RejectedIntentV1>(
  intent: T,
  now: Date,
): T {
  const exponent = Math.max(0, intent.attempts - 2)
  const delay = Math.min(
    INGEST_RETRY_INITIAL_MS * (2 ** exponent),
    INGEST_RETRY_MAX_MS,
  )
  return {
    ...intent,
    nextAttemptAt: new Date(now.getTime() + delay).toISOString(),
  } as T
}

function parseProtocolVersion(stdout: string): number | undefined {
  for (const line of stdout.trim().split(/\r?\n/).reverse()) {
    try {
      const protocolVersion = (JSON.parse(line) as { protocolVersion?: unknown })
        .protocolVersion
      if (typeof protocolVersion === 'number' && Number.isSafeInteger(protocolVersion)) {
        return protocolVersion
      }
    } catch {}
  }
  return undefined
}

function isIntentFilename(name: string): boolean {
  return /^\d{17,20}\.json$/.test(name)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
