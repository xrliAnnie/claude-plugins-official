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
import { homedir } from 'node:os'
import {
  encodeSpoolIntent,
  isIntentFilename,
  parseSpoolIntent,
  readMailboxDiscordFlag,
  type BeginArgs,
  type RecorderMode,
  type SpoolIntentV1,
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

export interface ReceiptNotification {
  content: string
  meta: Record<string, string>
}

export type NotifyFn = (notification: ReceiptNotification) => Promise<void>
export type AdviseFn = (chatId: string | undefined, text: string) => Promise<void>

interface PendingRow {
  seq: number
  id: string
  createdAt: string
  envelope: (BeginArgs & { v: 1; receiptId: string }) | null
  parse_error?: string
}

interface AdviceMarker {
  detectedAt: string
  advisedAt: string | null
}

interface SettleIntentV1 {
  v: 1
  messageId: string
  replyId: string
  chatId?: string
  attempts: number
  advisedAt: string | null
}

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

export interface ChatReceiptRuntimeOptions {
  mode: RecorderMode
  stateDir: string
  notify: NotifyFn
  advise: AdviseFn
  runCommand?: RunCommand
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  log?: (line: string) => void
  spoolDir?: string
  writeIntent?: (path: string, intent: SpoolIntentV1) => void
  writeIngestIntent?: (path: string, intent: IngestIntentV1) => void
  readMailboxFlag?: () => { enabled: boolean; readError?: string }
  founderId?: string
  setTimer?: (fn: () => void, delayMs: number) => ReturnType<typeof setTimeout>
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void
}

const COMMAND_TIMEOUT_MS = 5_000
const SPOOL_PER_PASS = 5
const PENDING_PAGE = 20
const PENDING_PER_PASS = 100
const PENDING_PAGE_DELAY_MS = 1_000
const QUARANTINE_AGE_MS = 48 * 60 * 60 * 1_000
const FILE_RETRY_ADVISE_AFTER = 5
const DEPTH_ADVISE_AFTER = 10
const INGEST_RETRY_INITIAL_MS = 5_000
const INGEST_RETRY_MAX_MS = 5 * 60_000
const INGEST_STALL_ADVISE_MS = 5 * 60_000

export class ChatReceiptRuntime {
  private readonly mode: RecorderMode
  private readonly notify: NotifyFn
  private readonly advise: AdviseFn
  private readonly runCommand: RunCommand
  private readonly now: () => Date
  private readonly sleep: (ms: number) => Promise<void>
  private readonly log: (line: string) => void
  private readonly spoolDir: string
  private readonly metaDir: string
  private readonly settleDir: string
  private readonly ingestDir: string
  private readonly writeIntent: (path: string, intent: SpoolIntentV1) => void
  private readonly writeIngestIntent: (path: string, intent: IngestIntentV1) => void
  private readonly readMailboxFlag: () => { enabled: boolean; readError?: string }
  private readonly founderId?: string
  private readonly setTimer: NonNullable<ChatReceiptRuntimeOptions['setTimer']>
  private readonly clearTimer: NonNullable<ChatReceiptRuntimeOptions['clearTimer']>
  private readonly activeAccept = new Set<string>()
  private lastChatId: string | undefined
  private dirty = false
  private workerPromise: Promise<void> | undefined
  private ingestWorkerPromise: Promise<void> | undefined
  private ingestDirty = false
  private ingestRetryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(opts: ChatReceiptRuntimeOptions) {
    this.mode = opts.mode
    this.notify = opts.notify
    this.advise = opts.advise
    this.runCommand = opts.runCommand ?? runCommand
    this.now = opts.now ?? (() => new Date())
    this.sleep = opts.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)))
    this.log = opts.log ?? (line => process.stderr.write(`[chat-receipt] ${line}\n`))
    this.spoolDir = opts.spoolDir ?? join(opts.stateDir, 'chat-receipt-spool')
    this.metaDir = join(this.spoolDir, 'meta')
    this.settleDir = join(this.spoolDir, 'settle')
    this.ingestDir = join(this.spoolDir, 'ingest')
    this.writeIntent = opts.writeIntent ?? writeIntentAtomic
    this.writeIngestIntent = opts.writeIngestIntent ?? writeJsonAtomic
    this.readMailboxFlag = opts.readMailboxFlag ?? (() =>
      readMailboxDiscordFlag(() =>
        readFileSync(join(homedir(), '.flywheel', '.env'), 'utf8'),
      ))
    this.founderId = opts.founderId
    this.setTimer = opts.setTimer ?? ((fn, delayMs) => setTimeout(fn, delayMs))
    this.clearTimer = opts.clearTimer ?? (timer => clearTimeout(timer))
  }

  markAccepting(messageId: string): void {
    this.activeAccept.add(messageId)
  }

  finishAccepting(messageId: string): void {
    this.activeAccept.delete(messageId)
  }

  async begin(args: BeginArgs): Promise<'ok' | 'spooled' | 'spool_failed'> {
    return (await this.beginWithVerdict(args)).status
  }

  async acceptInbound(args: BeginArgs): Promise<'mailbox' | 'legacy' | 'skip'> {
    if (this.mode.kind !== 'enabled') return 'legacy'
    const flag = this.readMailboxFlag()
    if (flag.readError) {
      this.log(JSON.stringify({
        event: 'discord_mailbox_flag_read_failed',
        message_id: args.messageId,
        error: flag.readError,
      }))
    }
    if (flag.enabled) {
      await this.ingest(args)
      return 'mailbox'
    }
    const begin = await this.beginWithVerdict(args)
    return begin.lane && begin.lane !== 'inserted_external' ? 'skip' : 'legacy'
  }

  private async beginWithVerdict(args: BeginArgs): Promise<{
    status: 'ok' | 'spooled' | 'spool_failed'
    lane?: DiscordLane
  }> {
    this.lastChatId = args.chatId
    if (this.mode.kind !== 'enabled') return { status: 'ok' }
    const command = await this.invoke('begin', beginFlags(args), args.text)
    const lane = parseLaneVerdict(command.stdout)
    if (succeeded(command)) return { status: 'ok', ...(lane ? { lane } : {}) }

    const intent: SpoolIntentV1 = {
      v: 1,
      begin: args,
      attempts: 0,
      advisedAt: null,
    }
    try {
      this.ensureSpoolDir()
      this.writeIntent(this.intentPath(args.messageId), intent)
      return { status: 'spooled' }
    } catch (error) {
      this.log(`begin failed and spool write failed for ${args.messageId}: ${errorText(error)}`)
      try {
        await this.advise(
          args.chatId,
          `Chat receipt could not persist its recovery intent for message ${args.messageId}; delivery continued, but receipt recovery needs operator attention.`,
        )
      } catch (adviseError) {
        this.log(`spool failure advisory also failed: ${errorText(adviseError)}`)
      }
      return { status: 'spool_failed' }
    }
  }

  private async ingest(args: BeginArgs): Promise<void> {
    this.lastChatId = args.chatId
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
        try {
          await this.advise(
            args.chatId,
            `Discord mailbox ingest could not persist recovery for message ${args.messageId}; this message may require manual replay.`,
          )
        } catch (adviseError) {
          this.log(`discord mailbox ingest emergency advisory failed: ${errorText(adviseError)}`)
        }
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

  async complete(messageId: string): Promise<boolean> {
    if (this.mode.kind !== 'enabled') return true
    return succeeded(await this.invoke('complete', [
      '--lead',
      this.mode.leadId,
      '--message-id',
      messageId,
      '--json',
    ]))
  }

  async deliver(args: BeginArgs): Promise<boolean> {
    if (this.mode.kind !== 'enabled') return true
    try {
      await withTimeout(
        this.notify(receiptNotification(args, false)),
        COMMAND_TIMEOUT_MS,
        'inbound notification',
      )
    } catch (error) {
      this.log(`inbound notify failed for ${args.messageId}: ${errorText(error)}`)
      return false
    }
    return this.complete(args.messageId)
  }

  async settle(
    messageId: string,
    replyId: string,
    chatId?: string,
  ): Promise<boolean> {
    if (this.mode.kind !== 'enabled') return true
    // Write-ahead: Discord has already persisted the reply reference, so the
    // proof must be durable BEFORE the settle CLI runs — a crash while the CLI
    // is in flight (or before a failure is observed) must leave a recovery
    // intent behind. The CLI settle is same-evidence idempotent, so replaying
    // a durable intent after a crash-past-success is a no-op success.
    let intentWritten = false
    try {
      this.ensureSettleDir()
      const path = this.settleIntentPath(messageId)
      const existing = readSettleIntent(path)
      const intent: SettleIntentV1 = existing ?? {
        v: 1,
        messageId,
        replyId,
        ...(chatId ? { chatId } : {}),
        attempts: 0,
        advisedAt: null,
      }
      writeJsonAtomic(path, intent)
      intentWritten = true
    } catch (error) {
      this.log(`settle recovery write failed for ${messageId}: ${errorText(error)}`)
      try {
        await this.advise(
          chatId,
          `Chat receipt settlement proof could not persist its recovery intent for message ${messageId}; operator repair is required.`,
        )
      } catch (adviseError) {
        this.log(`settle recovery advisory also failed: ${errorText(adviseError)}`)
      }
    }
    const command = await this.invokeSettle(messageId, replyId)
    if (!succeeded(command)) {
      this.log(`settle failed for ${messageId}: ${command.stderr || command.stdout}`)
      if (intentWritten) this.kickWorker()
      return false
    }
    try {
      rmSync(this.settleIntentPath(messageId), { force: true })
    } catch (error) {
      this.log(`could not remove stale settle intent for ${messageId}: ${errorText(error)}`)
    }
    return true
  }

  async adviseBroken(chatId: string): Promise<void> {
    if (this.mode.kind !== 'broken') return
    this.lastChatId = chatId
    try {
      await this.adviseWithMarker(
        'broken-advised.json',
        chatId,
        `Chat receipt recording is disabled because Flywheel wiring is incomplete (${this.mode.missing.join(', ')}). Delivery continued; operator repair is required.`,
      )
    } catch (error) {
      this.log(`could not persist broken-wiring advisory state: ${errorText(error)}`)
    }
  }

  async diagnoseNode(): Promise<void> {
    if (this.mode.kind !== 'enabled') return
    try {
      const result = await this.runCommand(['node', '--version'], {
        timeoutMs: COMMAND_TIMEOUT_MS,
      })
      if (!succeeded(result)) {
        this.log(`node preflight failed (receipt delivery remains fail-open): ${result.stderr}`)
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
      this.log(`Discord ingest preflight spawn failed (delivery remains fail-open): ${errorText(error)}`)
    }
  }

  kickWorker(): void {
    if (this.mode.kind !== 'enabled') return
    this.kickIngestWorker()
    this.dirty = true
    this.startWorkerIfNeeded()
  }

  async whenIdle(): Promise<void> {
    while (this.workerPromise || this.ingestWorkerPromise) {
      await Promise.all([this.workerPromise, this.ingestWorkerPromise])
    }
  }

  private kickIngestWorker(): void {
    if (this.ingestRetryTimer) this.clearTimer(this.ingestRetryTimer)
    this.ingestRetryTimer = undefined
    this.ingestDirty = true
    if (this.ingestWorkerPromise) return
    const running = this.ingestWorkerLoop()
    this.ingestWorkerPromise = running.finally(() => {
      this.ingestWorkerPromise = undefined
      if (this.ingestDirty) this.kickIngestWorker()
      else this.scheduleIngestRetry()
    })
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
    for (const path of paths.slice(0, SPOOL_PER_PASS)) {
      let intent = readIngestIntent(path)
      if (!intent) {
        try {
          renameSync(path, `${path}.corrupt`)
        } catch (error) {
          this.log(`could not preserve corrupt ingest intent ${basename(path)}: ${errorText(error)}`)
        }
        await this.adviseWithMarker(
          'ingest-corrupt-advised.json',
          this.lastChatId,
          `Discord mailbox recovery found a corrupt ingest intent (${basename(path)}).`,
        )
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
        this.now().getTime() - Date.parse(intent.firstFailedAt) >= INGEST_STALL_ADVISE_MS &&
        intent.advisedAt === null
      ) {
        try {
          await this.advise(
            intent.begin.chatId,
            `Discord mailbox ingest is stalled for message ${intent.begin.messageId}; recovery remains queued.`,
          )
          intent.advisedAt = this.now().toISOString()
        } catch (error) {
          this.log(`discord mailbox ingest stall advisory failed: ${errorText(error)}`)
        }
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

  private startWorkerIfNeeded(): void {
    if (this.workerPromise) return
    const running = this.workerLoop()
    this.workerPromise = running.finally(() => {
      this.workerPromise = undefined
      if (this.dirty) this.startWorkerIfNeeded()
    })
  }

  private async workerLoop(): Promise<void> {
    while (true) {
      this.dirty = false
      const pass = await this.runRecoveryPass()
      const kickDuringPass = this.dirty
      if (!pass.workRemains) break
      if (!pass.progress && !kickDuringPass) break
    }
  }

  private async runRecoveryPass(): Promise<PassResult> {
    const spool = await this.drainSpoolPass()
    const settle = await this.drainSettlePass()
    const pending = await this.reconcilePendingPass()
    return {
      progress: spool.progress || settle.progress || pending.progress,
      workRemains: spool.workRemains || settle.workRemains || pending.workRemains,
    }
  }

  private async drainSpoolPass(): Promise<PassResult> {
    await this.retryPendingCorruptAdvice()
    let intents = this.listIntentFiles()
    if (intents.length === 0) {
      this.removeDepthMarker()
      return { progress: false, workRemains: false }
    }
    if (intents.length > DEPTH_ADVISE_AFTER) {
      await this.adviseWithMarker(
        'depth-advised.json',
        this.lastChatId,
        `Chat receipt recovery backlog has ${intents.length} pending intents.`,
      )
    }

    let progress = false
    for (const path of intents.slice(0, SPOOL_PER_PASS)) {
      let intent: SpoolIntentV1
      try {
        intent = parseSpoolIntent(readFileSync(path, 'utf8'))
      } catch (error) {
        const corruptPath = `${path}.corrupt`
        try {
          renameSync(path, corruptPath)
        } catch (renameError) {
          this.log(`could not preserve corrupt intent ${basename(path)}: ${errorText(renameError)}`)
        }
        await this.adviseWithMarker(
          'corrupt-advised.json',
          this.lastChatId,
          `Chat receipt recovery found a corrupt intent file (${basename(path)}); the original was preserved with a .corrupt suffix.`,
        )
        continue
      }

      const command = await this.invoke('begin', beginFlags(intent.begin), intent.begin.text)
      if (succeeded(command)) {
        rmSync(path, { force: true })
        progress = true
        continue
      }

      intent.attempts += 1
      if (intent.attempts > FILE_RETRY_ADVISE_AFTER && intent.advisedAt === null) {
        try {
          await this.advise(
            intent.begin.chatId,
            `Chat receipt recovery has failed ${intent.attempts} times for message ${intent.begin.messageId}.`,
          )
          intent.advisedAt = this.now().toISOString()
        } catch (error) {
          this.log(`retry advisory failed for ${intent.begin.messageId}: ${errorText(error)}`)
        }
      }
      try {
        this.writeIntent(path, intent)
      } catch (error) {
        this.log(`could not update retry state for ${intent.begin.messageId}: ${errorText(error)}`)
      }
    }

    intents = this.listIntentFiles()
    if (intents.length === 0) this.removeDepthMarker()
    return { progress, workRemains: intents.length > 0 }
  }

  private async drainSettlePass(): Promise<PassResult> {
    let paths = this.listSettleIntentFiles()
    let progress = false
    for (const path of paths.slice(0, SPOOL_PER_PASS)) {
      const intent = readSettleIntent(path)
      if (!intent) {
        const corruptPath = `${path}.corrupt`
        try {
          renameSync(path, corruptPath)
        } catch (error) {
          this.log(`could not preserve corrupt settle intent ${basename(path)}: ${errorText(error)}`)
        }
        await this.adviseWithMarker(
          'settle-corrupt-advised.json',
          this.lastChatId,
          `Chat receipt recovery found a corrupt settlement intent (${basename(path)}); the original was preserved with a .corrupt suffix.`,
        )
        continue
      }

      const command = await this.invokeSettle(intent.messageId, intent.replyId)
      if (succeeded(command)) {
        rmSync(path, { force: true })
        progress = true
        continue
      }

      intent.attempts += 1
      if (intent.attempts > FILE_RETRY_ADVISE_AFTER && intent.advisedAt === null) {
        try {
          await this.advise(
            intent.chatId,
            `Chat receipt settlement recovery has failed ${intent.attempts} times for message ${intent.messageId}.`,
          )
          intent.advisedAt = this.now().toISOString()
        } catch (error) {
          this.log(`settle retry advisory failed for ${intent.messageId}: ${errorText(error)}`)
        }
      }
      try {
        writeJsonAtomic(path, intent)
      } catch (error) {
        this.log(`could not update settle retry state for ${intent.messageId}: ${errorText(error)}`)
      }
    }
    paths = this.listSettleIntentFiles()
    return { progress, workRemains: paths.length > 0 }
  }

  private async reconcilePendingPass(): Promise<PassResult> {
    if (this.mode.kind !== 'enabled') return { progress: false, workRemains: false }
    let cursor = 0
    let scanned = 0
    let sawRows = false
    let progress = false

    while (scanned < PENDING_PER_PASS) {
      const limit = Math.min(PENDING_PAGE, PENDING_PER_PASS - scanned)
      const command = await this.invoke('pending', [
        '--lead',
        this.mode.leadId,
        '--cursor',
        String(cursor),
        '--limit',
        String(limit),
        '--json',
      ])
      if (!succeeded(command)) {
        this.log(`pending scan failed: ${command.stderr || command.stdout}`)
        break
      }

      const page = parsePendingPage(command.stdout)
      if (!page) break
      if (page.rows.length === 0) break
      sawRows = true
      scanned += page.rows.length
      cursor = page.nextCursor

      for (const row of page.rows) {
        if (this.activeAccept.has(messageIdFromReceipt(row.id))) continue
        if (!row.envelope) {
          this.log(`pending row ${row.id} is not replayable: ${row.parse_error ?? 'missing envelope'}`)
          continue
        }
        const replay = validatedBegin(row.envelope)
        if (!replay) {
          this.log(`pending row ${row.id} has an invalid envelope`)
          continue
        }
        if (this.now().getTime() - Date.parse(row.createdAt) > QUARANTINE_AGE_MS) {
          const quarantine = await this.invoke('quarantine', [
            '--lead',
            this.mode.leadId,
            '--message-id',
            replay.messageId,
            '--json',
          ])
          if (!succeeded(quarantine)) {
            this.log(`quarantine failed for ${row.id}: ${quarantine.stderr || quarantine.stdout}`)
          }
        }
        try {
          await withTimeout(
            this.notify(receiptNotification(replay, true)),
            COMMAND_TIMEOUT_MS,
            'redelivery notification',
          )
        } catch (error) {
          this.log(`redelivery notify failed for ${row.id}: ${errorText(error)}`)
          continue
        }
        if (await this.complete(replay.messageId)) progress = true
      }

      if (page.rows.length < limit || scanned >= PENDING_PER_PASS) break
      await this.sleep(PENDING_PAGE_DELAY_MS)
    }

    return {
      progress,
      workRemains: sawRows || scanned >= PENDING_PER_PASS,
    }
  }

  private async invoke(
    subcommand: string,
    flags: string[],
    stdin?: string,
  ): Promise<CommandResult> {
    if (this.mode.kind !== 'enabled') return emptySuccess()
    const argv = [
      'node',
      this.mode.commCli,
      'chat-receipt',
      subcommand,
      '--db',
      this.mode.dbPath,
      ...flags,
    ]
    try {
      const command = await this.runCommand(argv, {
        ...(stdin !== undefined ? { stdin } : {}),
        timeoutMs: COMMAND_TIMEOUT_MS,
      })
      if (command.timedOut) this.log(`${subcommand} timed out after ${COMMAND_TIMEOUT_MS}ms`)
      return command
    } catch (error) {
      this.log(`${subcommand} spawn failed: ${errorText(error)}`)
      return {
        stdout: '',
        stderr: errorText(error),
        exitCode: 1,
        timedOut: false,
      }
    }
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

  private invokeSettle(messageId: string, replyId: string): Promise<CommandResult> {
    return this.invoke('settle', [
      '--lead',
      this.mode.kind === 'enabled' ? this.mode.leadId : '',
      '--message-id',
      messageId,
      '--reply-id',
      replyId,
      '--json',
    ])
  }

  private ensureSpoolDir(): void {
    mkdirSync(this.spoolDir, { recursive: true, mode: 0o700 })
    chmodSync(this.spoolDir, 0o700)
  }

  private intentPath(messageId: string): string {
    return join(this.spoolDir, `${messageId}.json`)
  }

  private ensureSettleDir(): void {
    mkdirSync(this.settleDir, { recursive: true, mode: 0o700 })
    chmodSync(this.settleDir, 0o700)
  }

  private ensureIngestDir(): void {
    mkdirSync(this.ingestDir, { recursive: true, mode: 0o700 })
    chmodSync(this.ingestDir, 0o700)
  }

  private ingestIntentPath(messageId: string): string {
    return join(this.ingestDir, `${messageId}.json`)
  }

  private settleIntentPath(messageId: string): string {
    return join(this.settleDir, `${messageId}.json`)
  }

  private listIntentFiles(): string[] {
    if (!existsSync(this.spoolDir)) return []
    return readdirSync(this.spoolDir)
      .filter(isIntentFilename)
      .map(name => join(this.spoolDir, name))
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
  }

  private listSettleIntentFiles(): string[] {
    if (!existsSync(this.settleDir)) return []
    return readdirSync(this.settleDir)
      .filter(isIntentFilename)
      .map(name => join(this.settleDir, name))
      .sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs)
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
      this.kickIngestWorker()
    }, delay)
    ;(this.ingestRetryTimer as { unref?: () => void }).unref?.()
  }

  private async adviseWithMarker(
    markerName: string,
    chatId: string | undefined,
    text: string,
  ): Promise<void> {
    mkdirSync(this.metaDir, { recursive: true, mode: 0o700 })
    chmodSync(this.metaDir, 0o700)
    const path = join(this.metaDir, markerName)
    let marker = readAdviceMarker(path)
    if (!marker) {
      marker = { detectedAt: this.now().toISOString(), advisedAt: null }
      writeJsonAtomic(path, marker)
    }
    if (marker.advisedAt !== null) return
    try {
      await this.advise(chatId, text)
      marker.advisedAt = this.now().toISOString()
      writeJsonAtomic(path, marker)
    } catch (error) {
      this.log(`${markerName} advisory failed: ${errorText(error)}`)
    }
  }

  private removeDepthMarker(): void {
    rmSync(join(this.metaDir, 'depth-advised.json'), { force: true })
  }

  private async retryPendingCorruptAdvice(): Promise<void> {
    const marker = readAdviceMarker(join(this.metaDir, 'corrupt-advised.json'))
    if (!marker || marker.advisedAt !== null) return
    await this.adviseWithMarker(
      'corrupt-advised.json',
      this.lastChatId,
      'Chat receipt recovery has a preserved corrupt intent file; operator inspection is required.',
    )
  }
}

export function receiptNotification(
  begin: BeginArgs,
  redelivery: boolean,
): ReceiptNotification {
  const attachments = begin.attachments
    .map(attachment => `${attachment.name} (${attachment.type}, ${attachment.sizeKb}KB)`)
    .join('; ')
  return {
    content: `${redelivery ? '[redelivery] ' : ''}${begin.text}`,
    meta: {
      chat_id: begin.chatId,
      message_id: begin.messageId,
      user: begin.authorName,
      user_id: begin.authorId,
      ts: begin.ts,
      receipt_id: `chat:${begin.leadId}:${begin.messageId}`,
      ...(begin.attachments.length > 0
        ? {
            attachment_count: String(begin.attachments.length),
            attachments,
          }
        : {}),
    },
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

function beginFlags(begin: BeginArgs): string[] {
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
    '--priority',
    String(begin.priority),
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

function parsePendingPage(
  stdout: string,
): { rows: PendingRow[]; nextCursor: number } | undefined {
  try {
    const decoded = JSON.parse(stdout) as {
      rows?: unknown
      nextCursor?: unknown
    }
    if (!Array.isArray(decoded.rows) || !Number.isSafeInteger(decoded.nextCursor)) {
      throw new Error('rows/nextCursor shape is invalid')
    }
    return {
      rows: decoded.rows as PendingRow[],
      nextCursor: decoded.nextCursor as number,
    }
  } catch (error) {
    process.stderr.write(`[chat-receipt] pending JSON is invalid: ${errorText(error)}\n`)
    return undefined
  }
}

function validatedBegin(envelope: PendingRow['envelope']): BeginArgs | undefined {
  if (!envelope) return undefined
  try {
    return parseSpoolIntent(JSON.stringify({
      v: 1,
      begin: envelope,
      attempts: 0,
      advisedAt: null,
    })).begin
  } catch {
    return undefined
  }
}

function messageIdFromReceipt(receiptId: string): string {
  return receiptId.slice(receiptId.lastIndexOf(':') + 1)
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

function writeIntentAtomic(path: string, intent: SpoolIntentV1): void {
  writeAtomic(path, encodeSpoolIntent(intent))
}

function writeJsonAtomic(path: string, value: unknown): void {
  writeAtomic(path, JSON.stringify(value))
}

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    writeFileSync(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    renameSync(tmp, path)
    chmodSync(path, 0o600)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

function readAdviceMarker(path: string): AdviceMarker | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as AdviceMarker
    if (
      typeof parsed.detectedAt === 'string' &&
      (parsed.advisedAt === null || typeof parsed.advisedAt === 'string')
    ) {
      return parsed
    }
  } catch {}
  return undefined
}

function readSettleIntent(path: string): SettleIntentV1 | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<SettleIntentV1>
    if (
      parsed.v === 1 &&
      typeof parsed.messageId === 'string' &&
      isIntentFilename(`${parsed.messageId}.json`) &&
      typeof parsed.replyId === 'string' &&
      isIntentFilename(`${parsed.replyId}.json`) &&
      (parsed.chatId === undefined || typeof parsed.chatId === 'string') &&
      Number.isSafeInteger(parsed.attempts) &&
      (parsed.attempts as number) >= 0 &&
      (parsed.advisedAt === null || typeof parsed.advisedAt === 'string')
    ) {
      return parsed as SettleIntentV1
    }
  } catch {}
  return undefined
}

function readIngestIntent(path: string): IngestIntentV1 | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<IngestIntentV1>
    const begin = validatedBegin(parsed.begin as PendingRow['envelope'])
    if (
      parsed.v === 1 &&
      begin &&
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

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
