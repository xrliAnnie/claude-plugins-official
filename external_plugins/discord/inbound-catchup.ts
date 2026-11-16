// FLY-5394 — inbound catch-up after a gateway gap.
//
// The Discord gateway does not replay events to a NEW session (process restart,
// or an in-process reconnect that could not RESUME). Messages sent to this Lead
// while no session was connected were therefore never seen. This module records
// a "catch-up window" at the moment a gap may begin (module load, gateway
// disconnect, a failed durable intake), and after the next gateway session is
// ready it reads each channel / thread's history from its last processed message
// id, feeding every message through the SAME intake chain as live delivery.
// A window is closed only by a catch-up run that claimed it at start and fully
// succeeded. See engineering/doc/FLY-5394-restart-message-catchup/plan.md in the
// Flywheel repository and INBOUND-CATCHUP.md next to this file.
//
// All Discord I/O, clocks, timers and files are injected so the state machine is
// unit-testable without a gateway.

import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

const DAY_MS = 24 * 60 * 60_000
export const DISCORD_EPOCH_MS = 1_420_070_400_000

export const CATCHUP_LIMITS = {
  marginMs: 120_000,
  noEvidenceMs: 15 * 60_000,
  pageSize: 100,
  requestRetryMs: [5_000, 30_000, 120_000],
  failureBackoffMs: [30_000, 120_000, 600_000],
  successCache: 10_000,
  debounceMs: 1_000,
  evidenceTickMs: 15_000,
  heardBootstrapMs: 7 * DAY_MS,
  heardExpireMs: 8 * DAY_MS,
  heardRefreshMs: DAY_MS,
  heardMax: 20_000,
  touchedMax: 20_000,
  windowsMax: 32,
  cursorsMax: 5_000,
  fileMaxBytes: 4 * 1024 * 1024,
} as const

export const STATE_FILE = 'inbound-catchup.json'
const GATEWAY_STATUS_FILE = 'gateway-status.json'
const SNOWFLAKE = /^\d{17,20}$/

// ── snowflakes ────────────────────────────────────────────────────────────

export function snowflakeMs(id: string): number {
  return Number(BigInt(id) >> 22n) + DISCORD_EPOCH_MS
}

/** The largest id strictly older than `ms`: `after=` this id returns every message at or after `ms`. */
export function floorSnowflake(ms: number): string {
  const offset = BigInt(Math.max(0, Math.floor(ms) - DISCORD_EPOCH_MS))
  const id = (offset << 22n) - 1n
  return (id < 0n ? 0n : id).toString()
}

export function compareIds(a: string, b: string): number {
  const x = BigInt(a)
  const y = BigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}

function maxId(a: string | undefined, b: string | undefined): string | undefined {
  if (a === undefined) return b
  if (b === undefined) return a
  return compareIds(a, b) >= 0 ? a : b
}

// ── persisted state ───────────────────────────────────────────────────────

export type WindowCause = 'startup' | 'startup_no_evidence' | 'disconnect' | 'failure' | 'merged'
const CAUSES: ReadonlySet<string> = new Set(['startup', 'startup_no_evidence', 'disconnect', 'failure', 'merged'])

export interface CatchupWindow {
  seq: number
  floorMs: number
  cause: WindowCause
  openedAtMs: number
}

export interface CatchupStateV1 {
  v: 1
  lead: string | null
  updatedAtMs: number
  liveThroughMs: number
  nextWindowSeq: number
  windows: CatchupWindow[]
  cursors: Record<string, string>
  heard: Record<string, number>
  heardBootstrap: { state: 'pending' | 'done'; sinceMs: number }
}

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value)

function leadConflicts(fileLead: unknown, envLead: string | undefined): boolean {
  return typeof fileLead === 'string' && fileLead !== '' && !!envLead && fileLead !== envLead
}

export function parseCatchupState(text: string, envLead: string | undefined, nowMs: number): Parsed<CatchupStateV1> {
  if (Buffer.byteLength(text, 'utf8') > CATCHUP_LIMITS.fileMaxBytes) return { ok: false, reason: 'too_large' }
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return { ok: false, reason: 'json' } }
  if (!isRecord(raw) || raw.v !== 1) return { ok: false, reason: 'version' }
  if (raw.lead !== null && typeof raw.lead !== 'string') return { ok: false, reason: 'lead' }
  if (leadConflicts(raw.lead, envLead)) return { ok: false, reason: 'lead_mismatch' }
  if (!finite(raw.updatedAtMs) || !finite(raw.liveThroughMs)) return { ok: false, reason: 'time' }
  const next = raw.nextWindowSeq
  if (typeof next !== 'number' || !Number.isSafeInteger(next) || next < 1) return { ok: false, reason: 'next_seq' }
  if (!Array.isArray(raw.windows) || raw.windows.length > CATCHUP_LIMITS.windowsMax) return { ok: false, reason: 'windows' }
  const windows: CatchupWindow[] = []
  for (const w of raw.windows) {
    if (!isRecord(w) || typeof w.seq !== 'number' || !Number.isSafeInteger(w.seq) || w.seq < 1 || w.seq >= next ||
      !finite(w.floorMs) || !finite(w.openedAtMs) || typeof w.cause !== 'string' || !CAUSES.has(w.cause)) {
      return { ok: false, reason: 'window' }
    }
    windows.push({ seq: w.seq, floorMs: w.floorMs, cause: w.cause as WindowCause, openedAtMs: w.openedAtMs })
  }
  if (!isRecord(raw.cursors)) return { ok: false, reason: 'cursors' }
  const cursorEntries = Object.entries(raw.cursors)
  if (cursorEntries.length > CATCHUP_LIMITS.cursorsMax) return { ok: false, reason: 'cursors_cap' }
  const cursors: Record<string, string> = {}
  for (const [k, v] of cursorEntries) {
    if (!SNOWFLAKE.test(k) || typeof v !== 'string' || !SNOWFLAKE.test(v)) return { ok: false, reason: 'cursor' }
    cursors[k] = v
  }
  if (!isRecord(raw.heard)) return { ok: false, reason: 'heard' }
  const heardEntries = Object.entries(raw.heard)
  if (heardEntries.length > CATCHUP_LIMITS.heardMax) return { ok: false, reason: 'heard_cap' }
  const heard: Record<string, number> = {}
  for (const [k, v] of heardEntries) {
    if (!SNOWFLAKE.test(k) || !finite(v)) return { ok: false, reason: 'heard_entry' }
    heard[k] = v
  }
  let heardBootstrap: CatchupStateV1['heardBootstrap'] = {
    state: 'pending', sinceMs: nowMs - CATCHUP_LIMITS.heardBootstrapMs,
  }
  if (raw.heardBootstrap !== undefined) {
    const b = raw.heardBootstrap
    if (!isRecord(b) || (b.state !== 'pending' && b.state !== 'done') || !finite(b.sinceMs)) {
      return { ok: false, reason: 'heard_bootstrap' }
    }
    heardBootstrap = { state: b.state, sinceMs: b.sinceMs }
  }
  return {
    ok: true,
    value: {
      v: 1, lead: raw.lead as string | null, updatedAtMs: raw.updatedAtMs, liveThroughMs: raw.liveThroughMs,
      nextWindowSeq: next, windows, cursors, heard, heardBootstrap,
    },
  }
}

/** Latest heartbeat ACK left by the PREVIOUS plugin process (first-upgrade evidence only). */
export function parseGatewayStatusEvidence(text: string, envLead: string | undefined): number | undefined {
  let raw: unknown
  try { raw = JSON.parse(text) } catch { return undefined }
  if (!isRecord(raw) || leadConflicts(raw.lead, envLead) || !Array.isArray(raw.shards)) return undefined
  let latest: number | undefined
  for (const shard of raw.shards) {
    if (isRecord(shard) && finite(shard.lastAckAt) && shard.lastAckAt > 0) {
      latest = latest === undefined ? shard.lastAckAt : Math.max(latest, shard.lastAckAt)
    }
  }
  return latest
}

export interface CatchupFiles {
  /** undefined when the file does not exist; throws on any other read error. */
  read(path: string): string | undefined
  /** Atomic, owner-only (0600) replacement. */
  write(path: string, text: string): void
}

export const nodeCatchupFiles: CatchupFiles = {
  read(path) {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw error
    }
  },
  write(path, text) {
    const dir = join(path, '..')
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const temp = `${path}.${randomUUID()}.tmp`
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    let renamed = false
    try {
      writeFileSync(fd, text)
      fsyncSync(fd)
      renameSync(temp, path)
      renamed = true
    } finally {
      closeSync(fd)
      if (!renamed) rmSync(temp, { force: true })
    }
  },
}

// ── once-per-message intake ───────────────────────────────────────────────

export type IntakeOutcome = 'done' | 'failed'
export type CatchupIntakeOutcome = IntakeOutcome | 'identity_closed'

/**
 * Shares only IN-FLIGHT calls and SUCCESSFUL results per message id. A failure is
 * never cached: the next attempt really runs again.
 */
export class HandledOnce {
  private readonly inflight = new Map<string, Promise<IntakeOutcome>>()
  private readonly succeeded = new Set<string>()

  constructor(private readonly cap: number = CATCHUP_LIMITS.successCache) {}

  run(id: string, fn: () => Promise<IntakeOutcome>): Promise<IntakeOutcome> {
    if (this.succeeded.has(id)) return Promise.resolve('done')
    const live = this.inflight.get(id)
    if (live) return live
    const running = (async () => fn())().then(outcome => {
      this.inflight.delete(id)
      if (outcome === 'done') {
        this.succeeded.add(id)
        if (this.succeeded.size > this.cap) {
          const oldest = this.succeeded.values().next().value
          if (oldest !== undefined) this.succeeded.delete(oldest)
        }
      }
      return outcome
    }, error => {
      this.inflight.delete(id)
      throw error
    })
    this.inflight.set(id, running)
    return running
  }
}

export interface IntakeTracker {
  begin(channelId: string, messageId: string, live: boolean): void
  finish(channelId: string, messageId: string, outcome: IntakeOutcome): void
  noteDone(channelId: string, messageId: string): void
}

export interface IntakeMessage {
  id: string
  channelId: string
  system: boolean
  author: { id: string; bot: boolean }
}

/**
 * The one admission chain shared by live delivery and catch-up: system and
 * non-allowlisted bot messages are dropped (processed), everything else goes to
 * `handle` (gate → mailbox). Live and catch-up meeting the same id run it once.
 */
export function createIntakePipeline<M extends IntakeMessage>(deps: {
  tracker?: IntakeTracker
  allowBots(): readonly string[] | undefined
  identityValid(): boolean
  allowsIntake(authorId: string): boolean
  handle(msg: M, origin: 'live' | 'catchup'): Promise<IntakeOutcome>
  log(line: string): void
  successCap?: number
}): {
  intake(msg: M, origin: 'live' | 'catchup'): Promise<IntakeOutcome>
  catchupIntake(msg: M): Promise<CatchupIntakeOutcome>
} {
  const once = new HandledOnce(deps.successCap)
  const intake = (msg: M, origin: 'live' | 'catchup'): Promise<IntakeOutcome> =>
    once.run(msg.id, async () => {
      deps.tracker?.begin(msg.channelId, msg.id, origin === 'live')
      let outcome: IntakeOutcome
      try {
        if (msg.system) outcome = 'done'
        else if (msg.author.bot && !deps.allowBots()?.includes(msg.author.id)) outcome = 'done'
        else outcome = await deps.handle(msg, origin)
      } catch (error) {
        deps.log(`discord: handleInbound failed: ${error}`)
        outcome = 'failed'
      }
      deps.tracker?.finish(msg.channelId, msg.id, outcome)
      return outcome
    })
  const catchupIntake = async (msg: M): Promise<CatchupIntakeOutcome> => {
    if (!deps.identityValid()) return 'identity_closed'
    if (!deps.allowsIntake(msg.author.id)) {
      deps.tracker?.noteDone(msg.channelId, msg.id)
      return 'done'
    }
    return intake(msg, 'catchup')
  }
  return { intake, catchupIntake }
}

// ── Discord access (injected) ─────────────────────────────────────────────

export interface ChannelMeta {
  id: string
  /** text: has messages and may own threads; forum: owns threads only. */
  kind: 'text' | 'forum' | 'thread' | 'skip'
  parentId: string | null
  guildId: string | null
  lastMessageId: string | null
  archiveTimestamp: number | null
}

export interface CatchupDiscord<M> {
  /** Fresh REST read (bypasses the discord.js cache). null or a 404 error: deleted. */
  fetchChannel(id: string): Promise<ChannelMeta | null>
  fetchActiveThreads(guildId: string): Promise<ChannelMeta[]>
  fetchArchivedPublicThreads(
    channelId: string,
    beforeMs: number | undefined,
  ): Promise<{ threads: ChannelMeta[]; hasMore: boolean }>
  /** The OLDEST `limit` messages strictly newer than `after`. */
  fetchMessagesAfter(channelId: string, after: string, limit: number): Promise<M[]>
}

export function errorStatus(error: unknown): number | undefined {
  const status = isRecord(error) ? error.status : undefined
  return typeof status === 'number' ? status : undefined
}

type Rest<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'missing' }
  | { kind: 'forbidden' }
  | { kind: 'error'; reason: string }

export interface CatchupTimers {
  setTimeout(fn: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

const nodeTimers: CatchupTimers = {
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms)
    handle.unref?.()
    return handle
  },
  clearTimeout(handle) { clearTimeout(handle as ReturnType<typeof setTimeout>) },
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    timer.unref?.()
    function done() {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export interface InboundCatchupOptions<M extends { id: string; channelId: string }> {
  mode: 'enabled' | 'broken'
  stateDir: string
  leadId?: string
  now?: () => number
  log: (line: string) => void
  /** Current access.json group (channel) ids, read fresh per call. */
  groups: () => readonly string[]
  discord: CatchupDiscord<M>
  intake: (msg: M) => Promise<CatchupIntakeOutcome>
  files?: CatchupFiles
  timers?: CatchupTimers
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

interface ChannelTrack {
  entries: Map<string, 'inflight' | 'done' | 'failed'>
  through?: string
}

export interface CatchupRunStats {
  channels: number
  fetched: number
  delivered: number
  failed: number
}

export class InboundCatchup<M extends { id: string; channelId: string }> implements IntakeTracker {
  private readonly opts: InboundCatchupOptions<M>
  private readonly now: () => number
  private readonly files: CatchupFiles
  private readonly timers: CatchupTimers
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>
  private readonly statePath: string
  private state: CatchupStateV1

  private aliveMs: number | undefined
  private readonly liveInflight = new Map<string, number>()
  private readonly tracks = new Map<string, ChannelTrack>()
  private readonly caughtSeq = new Map<string, number>()
  private readonly touched = new Map<string, string>()

  private connected = false
  private everConnected = false
  private inDisconnect = false
  private scheduled = false
  private running: Promise<void> | undefined
  private rerun = false
  private pendingRun = false
  private runSawDisconnect = false
  private abort: AbortController | undefined
  private stopped = false
  private backoffTimer: unknown
  private failureStreak = 0
  private saveTimer: unknown
  private lastWriteError = ''

  constructor(opts: InboundCatchupOptions<M>) {
    this.opts = opts
    this.now = opts.now ?? Date.now
    this.files = opts.files ?? nodeCatchupFiles
    this.timers = opts.timers ?? nodeTimers
    this.sleep = opts.sleep ?? abortableSleep
    this.statePath = join(opts.stateDir, STATE_FILE)

    // Startup window: written synchronously before the gateway login.
    const now = this.now()
    const loaded = this.loadState(now)
    let floorMs: number
    let cause: WindowCause
    if (loaded) {
      this.state = loaded
      if (this.state.lead === null && opts.leadId) this.state.lead = opts.leadId
      floorMs = loaded.liveThroughMs - CATCHUP_LIMITS.marginMs
      cause = 'startup'
    } else {
      const evidence = this.loadPreviousGatewayEvidence()
      if (evidence !== undefined) {
        floorMs = evidence - CATCHUP_LIMITS.marginMs
        cause = 'startup'
      } else {
        floorMs = now - CATCHUP_LIMITS.noEvidenceMs
        cause = 'startup_no_evidence'
      }
      this.state = {
        v: 1, lead: opts.leadId || null, updatedAtMs: now,
        liveThroughMs: floorMs + CATCHUP_LIMITS.marginMs,
        nextWindowSeq: 1, windows: [], cursors: {}, heard: {},
        heardBootstrap: { state: 'pending', sinceMs: now - CATCHUP_LIMITS.heardBootstrapMs },
      }
    }
    this.openWindow(cause, Math.min(floorMs, now - CATCHUP_LIMITS.marginMs))
  }

  // ── observation (live path) ─────────────────────────────────────────────

  /** A live gateway message (including this bot's own echo): the connection was alive now. */
  noteLive(msg: { channelId: string; threadParentId: string | null }): void {
    const now = this.now()
    this.aliveMs = this.aliveMs === undefined ? now : Math.max(this.aliveMs, now)
    if (msg.threadParentId && this.opts.groups().includes(msg.threadParentId)) this.noteHeard(msg.channelId)
  }

  /** A heartbeat ACK of the current session (15 s telemetry tick). */
  noteAck(ackMs: number | undefined): void {
    if (ackMs !== undefined && Number.isFinite(ackMs) && ackMs <= this.now()) {
      this.aliveMs = this.aliveMs === undefined ? ackMs : Math.max(this.aliveMs, ackMs)
    }
    this.scheduleSave()
  }

  /** Raw gateway dispatch packets: remembers threads whose state moved while a window is open. */
  noteRaw(packet: unknown): void {
    if (!this.tracking()) {
      this.touched.clear()
      return
    }
    if (!isRecord(packet)) return
    const t = packet.t
    if (t !== 'THREAD_CREATE' && t !== 'THREAD_UPDATE' && t !== 'THREAD_LIST_SYNC') return
    const d = packet.d
    if (!isRecord(d)) return
    const threads = t === 'THREAD_LIST_SYNC' ? (Array.isArray(d.threads) ? d.threads : []) : [d]
    const groups = new Set(this.opts.groups())
    for (const thread of threads) {
      if (!isRecord(thread)) continue
      const id = thread.id
      const parent = thread.parent_id
      if (typeof id !== 'string' || !SNOWFLAKE.test(id) || typeof parent !== 'string' || !groups.has(parent)) continue
      this.touched.delete(id)
      this.touched.set(id, parent)
      if (this.touched.size > CATCHUP_LIMITS.touchedMax) {
        const oldest = this.touched.keys().next().value
        if (oldest !== undefined) this.touched.delete(oldest)
      }
    }
  }

  begin(channelId: string, messageId: string, live: boolean): void {
    if (live) this.liveInflight.set(messageId, this.now())
    this.track(channelId).entries.set(messageId, 'inflight')
  }

  finish(channelId: string, messageId: string, outcome: IntakeOutcome): void {
    this.liveInflight.delete(messageId)
    this.track(channelId).entries.set(messageId, outcome)
    if (outcome === 'failed') {
      this.openWindow('failure', snowflakeMs(messageId) - 1)
      if (this.opts.mode === 'enabled') this.scheduleBackoff()
    }
    this.recompute(channelId)
  }

  noteDone(channelId: string, messageId: string): void {
    this.track(channelId).entries.set(messageId, 'done')
    this.recompute(channelId)
  }

  // ── gateway lifecycle ───────────────────────────────────────────────────

  onConnected(): void {
    this.connected = true
    this.everConnected = true
    this.inDisconnect = false
    if (this.state.windows.length > 0 || this.pendingRun) this.trigger()
  }

  onDisconnected(): void {
    this.connected = false
    if (this.running) this.runSawDisconnect = true
    if (this.inDisconnect) return
    this.inDisconnect = true
    // Before this process ever connected, the still-open startup window covers it.
    if (!this.everConnected) return
    this.openWindow('disconnect', this.liveThroughMs() - CATCHUP_LIMITS.marginMs)
  }

  /** Best effort on exit: abort the run (closing nothing) and flush state. */
  shutdown(): void {
    this.stopped = true
    this.abort?.abort()
    if (this.backoffTimer !== undefined) this.timers.clearTimeout(this.backoffTimer)
    if (this.saveTimer !== undefined) this.timers.clearTimeout(this.saveTimer)
    this.backoffTimer = undefined
    this.saveTimer = undefined
    this.saveNow()
  }

  async whenIdle(): Promise<void> {
    for (let i = 0; i < 1000 && (this.scheduled || this.running); i++) {
      if (this.running) await this.running
      else await Promise.resolve()
    }
  }

  // ── read-only views (tests / logs) ──────────────────────────────────────

  snapshot(): CatchupStateV1 {
    return structuredClone({ ...this.state, liveThroughMs: this.liveThroughMs() })
  }

  touchedIds(): string[] {
    return [...this.touched.keys()]
  }

  /** Durable live evidence: min(last alive moment, earliest live message still in flight). */
  liveThroughMs(): number {
    if (this.aliveMs === undefined) return this.state.liveThroughMs
    let through = this.aliveMs
    for (const received of this.liveInflight.values()) through = Math.min(through, received)
    return through
  }

  // ── windows and cursors ─────────────────────────────────────────────────

  private tracking(): boolean {
    return this.state.windows.length > 0 || this.running !== undefined
  }

  private openWindow(cause: WindowCause, floorMs: number): void {
    const window: CatchupWindow = { seq: this.state.nextWindowSeq++, floorMs, cause, openedAtMs: this.now() }
    this.state.windows.push(window)
    this.opts.log(`inbound-catchup window_open seq=${window.seq} cause=${cause} floor=${iso(floorMs)}`)
    if (this.state.windows.length > CATCHUP_LIMITS.windowsMax) {
      const merged: CatchupWindow = {
        seq: Math.max(...this.state.windows.map(w => w.seq)),
        floorMs: Math.min(...this.state.windows.map(w => w.floorMs)),
        cause: 'merged',
        openedAtMs: Math.min(...this.state.windows.map(w => w.openedAtMs)),
      }
      this.opts.log(`inbound-catchup windows_merged count=${this.state.windows.length} seq=${merged.seq} floor=${iso(merged.floorMs)}`)
      this.state.windows = [merged]
    }
    this.saveNow()
  }

  private maxOpenSeq(): number {
    let max = 0
    for (const w of this.state.windows) max = Math.max(max, w.seq)
    return max
  }

  private isCaught(channelId: string): boolean {
    return (this.caughtSeq.get(channelId) ?? 0) >= this.maxOpenSeq()
  }

  private track(channelId: string): ChannelTrack {
    let track = this.tracks.get(channelId)
    if (!track) {
      track = { entries: new Map() }
      this.tracks.set(channelId, track)
    }
    return track
  }

  /** In-memory "processed through": the largest done id with no in-flight/failed id below it. */
  private recompute(channelId: string): void {
    const track = this.track(channelId)
    let blocker: string | undefined
    for (const [id, state] of track.entries) {
      if (state !== 'done' && (blocker === undefined || compareIds(id, blocker) < 0)) blocker = id
    }
    let through = track.through
    for (const [id, state] of track.entries) {
      if (state === 'done' && (blocker === undefined || compareIds(id, blocker) < 0)) through = maxId(through, id)
    }
    track.through = through
    if (through !== undefined) {
      for (const [id, state] of track.entries) {
        if (state === 'done' && compareIds(id, through) <= 0) track.entries.delete(id)
      }
    }
    this.followLive(channelId)
  }

  /** A channel caught up on every open window persists its live progress; others stay behind the barrier. */
  private followLive(channelId: string): void {
    const through = this.tracks.get(channelId)?.through
    if (through === undefined || !this.isCaught(channelId)) return
    const current = this.state.cursors[channelId]
    if (current !== undefined && compareIds(current, through) >= 0) return
    this.state.cursors[channelId] = through
    this.scheduleSave()
  }

  private advanceProgress(channelId: string, id: string): void {
    const current = this.state.cursors[channelId]
    if (current !== undefined && compareIds(current, id) >= 0) return
    this.state.cursors[channelId] = id
  }

  private setCaught(channelId: string, seq: number): void {
    this.caughtSeq.set(channelId, Math.max(this.caughtSeq.get(channelId) ?? 0, seq))
    this.followLive(channelId)
  }

  private noteHeard(threadId: string): void {
    const now = this.now()
    const previous = this.state.heard[threadId]
    this.state.heard[threadId] = now
    if (previous === undefined || now - previous > CATCHUP_LIMITS.heardRefreshMs) this.saveNow()
    else this.scheduleSave()
  }

  // ── persistence ─────────────────────────────────────────────────────────

  private loadState(now: number): CatchupStateV1 | undefined {
    let text: string | undefined
    try {
      text = this.files.read(this.statePath)
    } catch (error) {
      this.opts.log(`inbound-catchup state_invalid reason=read_failed error=${errorText(error)}`)
      return undefined
    }
    if (text === undefined) return undefined
    const parsed = parseCatchupState(text, this.opts.leadId, now)
    if (parsed.ok) return parsed.value
    this.opts.log(`inbound-catchup state_invalid reason=${parsed.reason}`)
    return undefined
  }

  private loadPreviousGatewayEvidence(): number | undefined {
    try {
      const text = this.files.read(join(this.opts.stateDir, GATEWAY_STATUS_FILE))
      return text === undefined ? undefined : parseGatewayStatusEvidence(text, this.opts.leadId)
    } catch {
      return undefined
    }
  }

  private scheduleSave(): void {
    if (this.saveTimer !== undefined || this.stopped) return
    this.saveTimer = this.timers.setTimeout(() => {
      this.saveTimer = undefined
      this.saveNow()
    }, CATCHUP_LIMITS.debounceMs)
  }

  private saveNow(): void {
    if (this.saveTimer !== undefined) {
      this.timers.clearTimeout(this.saveTimer)
      this.saveTimer = undefined
    }
    const now = this.now()
    const liveThroughMs = this.liveThroughMs()
    this.state.liveThroughMs = liveThroughMs
    this.state.updatedAtMs = now
    this.prune(now, liveThroughMs)
    try {
      this.files.write(this.statePath, `${JSON.stringify(this.state)}\n`)
      this.lastWriteError = ''
    } catch (error) {
      const text = errorText(error)
      if (text !== this.lastWriteError) this.opts.log(`inbound-catchup state_write_failed error=${text}`)
      this.lastWriteError = text
    }
  }

  private prune(now: number, liveThroughMs: number): void {
    let threshold = liveThroughMs - CATCHUP_LIMITS.marginMs
    for (const w of this.state.windows) threshold = Math.min(threshold, w.floorMs)
    let cursors = Object.entries(this.state.cursors).filter(([, id]) => snowflakeMs(id) >= threshold)
    if (cursors.length > CATCHUP_LIMITS.cursorsMax) {
      cursors.sort((a, b) => compareIds(b[1], a[1]))
      cursors = cursors.slice(0, CATCHUP_LIMITS.cursorsMax)
    }
    this.state.cursors = Object.fromEntries(cursors)

    let heard = Object.entries(this.state.heard).filter(([, at]) => at >= now - CATCHUP_LIMITS.heardExpireMs)
    if (heard.length > CATCHUP_LIMITS.heardMax) {
      heard.sort((a, b) => b[1] - a[1])
      this.opts.log(`inbound-catchup heard_capped dropped=${heard.length - CATCHUP_LIMITS.heardMax}`)
      heard = heard.slice(0, CATCHUP_LIMITS.heardMax)
    }
    this.state.heard = Object.fromEntries(heard)
  }

  // ── runs ────────────────────────────────────────────────────────────────

  private trigger(): void {
    if (this.opts.mode !== 'enabled' || this.stopped) return
    if (this.running || this.scheduled) {
      this.rerun = true
      return
    }
    if (!this.connected) {
      this.pendingRun = true
      return
    }
    this.scheduled = true
    void Promise.resolve().then(() => {
      this.scheduled = false
      this.startRun()
    })
  }

  private scheduleBackoff(): void {
    if (this.backoffTimer !== undefined || this.stopped) return
    const delays = CATCHUP_LIMITS.failureBackoffMs
    const delay = delays[Math.min(this.failureStreak, delays.length - 1)]!
    this.failureStreak += 1
    this.backoffTimer = this.timers.setTimeout(() => {
      this.backoffTimer = undefined
      this.trigger()
    }, delay)
  }

  private startRun(): void {
    if (this.stopped || this.running) return
    if (!this.connected) {
      this.pendingRun = true
      return
    }
    this.pendingRun = false
    this.rerun = false
    this.runSawDisconnect = false
    const abort = new AbortController()
    this.abort = abort
    this.running = this.runOnce(abort).catch(error => {
      this.opts.log(`inbound-catchup incomplete reason=crashed error=${errorText(error)}`)
      return false
    }).then(success => {
      this.running = undefined
      this.abort = undefined
      if (this.stopped) return
      if (success) {
        this.failureStreak = 0
        // Windows opened while this run worked (a new failure) keep their scheduled retry.
        if (this.state.windows.length === 0 && this.backoffTimer !== undefined) {
          this.timers.clearTimeout(this.backoffTimer)
          this.backoffTimer = undefined
        }
      }
      if (!this.tracking()) this.touched.clear()
      if (this.rerun) this.trigger()
      else if (!success) {
        if (this.runSawDisconnect) {
          if (this.connected) this.trigger()
          else this.pendingRun = true
        } else {
          this.scheduleBackoff()
        }
      }
    })
  }

  private async rest<T>(fn: () => Promise<T>, signal: AbortSignal): Promise<Rest<NonNullable<T>>> {
    const retries = CATCHUP_LIMITS.requestRetryMs
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) return { kind: 'error', reason: 'aborted' }
      try {
        const value = await fn()
        if (value === null || value === undefined) return { kind: 'missing' }
        return { kind: 'ok', value }
      } catch (error) {
        const status = errorStatus(error)
        if (status === 404) return { kind: 'missing' }
        if (status === 403) return { kind: 'forbidden' }
        if (attempt >= retries.length) {
          return { kind: 'error', reason: status === undefined ? errorText(error) : `status_${status}` }
        }
        await this.sleep(retries[attempt]!, signal)
      }
    }
  }

  private async runOnce(abort: AbortController): Promise<boolean> {
    const owned = this.state.windows.map(w => ({ ...w }))
    if (owned.length === 0) return true
    const ownedSeqs = new Set(owned.map(w => w.seq))
    const ownedMax = Math.max(...owned.map(w => w.seq))
    const floorMs = Math.min(...owned.map(w => w.floorMs))
    const floorId = floorSnowflake(floorMs)
    const signal = abort.signal
    const startedAt = this.now()
    const stats: CatchupRunStats = { channels: 0, fetched: 0, delivered: 0, failed: 0 }
    const label = `windows=${owned.map(w => w.seq).join(',')}`
    this.opts.log(`inbound-catchup start ${label} floor=${iso(floorMs)} causes=${[...new Set(owned.map(w => w.cause))].join(',')}`)

    const reasons = new Set<string>()
    const groups = new Set(this.opts.groups())
    const meta = new Map<string, ChannelMeta>()
    const queue = new Set<string>()
    const bootstrap = this.state.heardBootstrap.state === 'pending' ? { ...this.state.heardBootstrap } : undefined
    const bootstrapHeard = new Map<string, number>()
    let bootstrapOk = true
    const listingFailed = (reason: string) => {
      reasons.add(reason)
      bootstrapOk = false
    }

    // 1. identity channels (fresh REST, never the cache)
    const guilds = new Set<string>()
    const threadParents: string[] = []
    for (const id of groups) {
      const r = await this.rest(() => this.opts.discord.fetchChannel(id), signal)
      if (r.kind === 'error') { listingFailed('identity_listing'); continue }
      if (r.kind === 'missing') { this.opts.log(`inbound-catchup skipped_missing channel=${id}`); continue }
      if (r.kind === 'forbidden') { this.opts.log(`inbound-catchup skipped_forbidden channel=${id}`); continue }
      const m = r.value
      if (m.kind === 'skip') { this.opts.log(`inbound-catchup skipped_kind channel=${id}`); continue }
      meta.set(id, m)
      queue.add(id)
      if (m.guildId) guilds.add(m.guildId)
      if (m.kind !== 'thread') threadParents.push(id)
    }

    // 2. active threads per guild
    const active = new Set<string>()
    for (const guildId of guilds) {
      const r = await this.rest(() => this.opts.discord.fetchActiveThreads(guildId), signal)
      if (r.kind !== 'ok') { listingFailed('active_listing'); continue }
      for (const t of r.value) {
        if (!t.parentId || !groups.has(t.parentId)) continue
        meta.set(t.id, t)
        queue.add(t.id)
        active.add(t.id)
        if (bootstrap) addBootstrap(bootstrapHeard, t)
      }
    }

    // 3. public threads archived since the floor (and since the bootstrap horizon while pending)
    const archivedSince = bootstrap ? Math.min(floorMs, bootstrap.sinceMs) : floorMs
    for (const parentId of threadParents) {
      let before: number | undefined
      for (;;) {
        const r = await this.rest(() => this.opts.discord.fetchArchivedPublicThreads(parentId, before), signal)
        if (r.kind === 'forbidden') { this.opts.log(`inbound-catchup skipped_forbidden channel=${parentId} list=archived`); break }
        if (r.kind === 'missing') break
        if (r.kind === 'error') { listingFailed('archived_listing'); break }
        let oldest = Number.POSITIVE_INFINITY
        for (const t of r.value.threads) {
          const at = t.archiveTimestamp ?? 0
          oldest = Math.min(oldest, at)
          if (at < archivedSince || !t.parentId || !groups.has(t.parentId)) continue
          if (at >= floorMs && !meta.has(t.id)) {
            meta.set(t.id, t)
            queue.add(t.id)
          }
          if (bootstrap) addBootstrap(bootstrapHeard, t)
        }
        if (!r.value.hasMore || r.value.threads.length === 0 || oldest < archivedSince) break
        before = oldest
      }
    }

    // 0'. one-time bootstrap of the recently-heard list (persisted obligation)
    if (bootstrap) {
      if (bootstrapOk && !signal.aborted) {
        const now = this.now()
        for (const id of this.touched.keys()) bootstrapHeard.set(id, Math.max(bootstrapHeard.get(id) ?? 0, now))
        for (const [id, at] of bootstrapHeard) {
          if ((this.state.heard[id] ?? Number.NEGATIVE_INFINITY) < at) this.state.heard[id] = at
        }
        this.state.heardBootstrap = { state: 'done', sinceMs: bootstrap.sinceMs }
        this.opts.log(`inbound-catchup heard_bootstrap threads=${bootstrapHeard.size}`)
        this.saveNow()
      } else {
        reasons.add('heard_bootstrap_pending')
      }
    }

    // 0. recently-heard threads, read by id (independent of any listing)
    const heardCutoff = this.now() - CATCHUP_LIMITS.heardExpireMs
    for (const [id, at] of Object.entries(this.state.heard)) {
      if (signal.aborted) break
      if (at < heardCutoff || active.has(id)) continue
      const r = await this.rest(() => this.opts.discord.fetchChannel(id), signal)
      if (r.kind === 'missing') { delete this.state.heard[id]; this.setCaught(id, ownedMax); queue.delete(id); continue }
      if (r.kind === 'forbidden') {
        this.opts.log(`inbound-catchup skipped_forbidden channel=${id}`)
        this.setCaught(id, ownedMax)
        queue.delete(id)
        continue
      }
      if (r.kind === 'error') { reasons.add('heard_fetch'); continue }
      const m = r.value
      if (m.kind !== 'thread' || !m.parentId || !groups.has(m.parentId)) continue
      meta.set(id, m)
      queue.add(id)
    }

    // 4. drain: queue ∪ touched, ascending ids, until touched adds nothing new
    const processed = new Set<string>()
    let identityClosed = false
    outer: for (;;) {
      const pending = [...new Set([...queue, ...this.touched.keys()])]
        .filter(id => !processed.has(id))
        .sort(compareIds)
      if (pending.length === 0) break
      for (const id of pending) {
        if (signal.aborted) break outer
        processed.add(id)
        let m: ChannelMeta | undefined = meta.get(id)
        if (!m) {
          const r = await this.rest(() => this.opts.discord.fetchChannel(id), signal)
          if (r.kind === 'missing') { this.setCaught(id, ownedMax); continue }
          if (r.kind === 'forbidden') { this.opts.log(`inbound-catchup skipped_forbidden channel=${id}`); this.setCaught(id, ownedMax); continue }
          if (r.kind === 'error') { reasons.add('touched_fetch'); continue }
          m = r.value
          if (m.kind !== 'thread' || !m.parentId || !groups.has(m.parentId)) continue
        }
        const result = await this.catchUpChannel(m, floorId, ownedMax, signal, stats, groups)
        if (result === 'identity_closed') {
          identityClosed = true
          reasons.add('identity_closed')
          break outer
        }
        if (result === 'incomplete') reasons.add('channel_incomplete')
      }
    }

    if (signal.aborted) reasons.add('aborted')
    if (this.runSawDisconnect) reasons.add('disconnected_during_run')
    if (stats.failed > 0) reasons.add('intake_failed')
    const success = reasons.size === 0 && !identityClosed
    const tail = `${label} channels=${stats.channels} fetched=${stats.fetched} delivered=${stats.delivered} failed=${stats.failed} ms=${this.now() - startedAt}`
    if (success) {
      this.state.windows = this.state.windows.filter(w => !ownedSeqs.has(w.seq))
      for (const seq of ownedSeqs) this.opts.log(`inbound-catchup window_close seq=${seq} by=run`)
      for (const channelId of this.tracks.keys()) this.followLive(channelId)
      this.opts.log(`inbound-catchup done ${tail}`)
      this.saveNow()
    } else {
      this.opts.log(`inbound-catchup incomplete reason=${[...reasons].join(',')} ${tail}`)
      this.scheduleSave()
    }
    return success
  }

  private async catchUpChannel(
    m: ChannelMeta,
    floorId: string,
    ownedMax: number,
    signal: AbortSignal,
    stats: CatchupRunStats,
    groups: ReadonlySet<string>,
  ): Promise<'caught' | 'incomplete' | 'identity_closed'> {
    const channelId = m.id
    const cursor = this.state.cursors[channelId]
    const start = cursor !== undefined && compareIds(cursor, floorId) > 0 ? cursor : floorId
    if (m.kind === 'forum' || !m.lastMessageId || compareIds(m.lastMessageId, start) <= 0) {
      this.setCaught(channelId, ownedMax)
      return 'caught'
    }
    const isHeardThread = m.kind === 'thread' && !!m.parentId && groups.has(m.parentId)
    stats.channels += 1
    let after = start
    let progressing = true
    let channelOk = true
    let reachedEnd = false
    while (!signal.aborted) {
      const r = await this.rest(
        () => this.opts.discord.fetchMessagesAfter(channelId, after, CATCHUP_LIMITS.pageSize), signal)
      if (r.kind === 'missing') { reachedEnd = true; break }
      if (r.kind === 'forbidden') {
        this.opts.log(`inbound-catchup skipped_forbidden channel=${channelId}`)
        reachedEnd = true
        break
      }
      if (r.kind === 'error') { channelOk = false; break }
      const page = [...r.value].sort((a, b) => compareIds(a.id, b.id))
      if (page.some(msg => compareIds(msg.id, after) <= 0)) {
        this.opts.log(`inbound-catchup page_not_forward channel=${channelId} after=${after}`)
        channelOk = false
        break
      }
      for (const msg of page) {
        if (signal.aborted) break
        stats.fetched += 1
        const outcome = await this.opts.intake(msg)
        if (outcome === 'identity_closed') return 'identity_closed'
        if (outcome === 'failed') {
          stats.failed += 1
          channelOk = false
          progressing = false
        } else {
          stats.delivered += 1
          if (progressing) this.advanceProgress(channelId, msg.id)
        }
        if (isHeardThread) this.noteHeard(channelId)
      }
      this.scheduleSave()
      if (page.length === 0) { reachedEnd = true; break }
      after = page[page.length - 1]!.id
      if (page.length < CATCHUP_LIMITS.pageSize) { reachedEnd = true; break }
    }
    if (reachedEnd && channelOk && !signal.aborted) {
      this.setCaught(channelId, ownedMax)
      return 'caught'
    }
    return 'incomplete'
  }
}

function addBootstrap(target: Map<string, number>, t: ChannelMeta): void {
  const at = t.lastMessageId ? snowflakeMs(t.lastMessageId) : t.archiveTimestamp
  if (at === null || !Number.isFinite(at)) return
  target.set(t.id, Math.max(target.get(t.id) ?? Number.NEGATIVE_INFINITY, at))
}

function iso(ms: number): string {
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : String(ms)
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
