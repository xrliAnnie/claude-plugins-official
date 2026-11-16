import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, Events } from 'discord.js'
import {
  AdmissionMemo,
  CATCHUP_LIMITS,
  DISCORD_EPOCH_MS,
  HandledOnce,
  InboundCatchup,
  STATE_FILE,
  createIntakePipeline,
  floorSnowflake,
  nodeCatchupFiles,
  parseCatchupState,
  snowflakeMs,
  type CatchupDiscord,
  type CatchupFiles,
  type CatchupStateV1,
  type ChannelMeta,
  type IntakeOutcome,
} from './inbound-catchup'
import { SelfAuthorFilter, attachSelfAuthorFilter } from './self-author-filter'
import { createThreadBudgetStore, decideTopicThreadHandling, seedThreadBudget } from './roundtable-thread-policy'

// FLY-5394: every Discord, clock, timer and file dependency is a local fake.
const SELF = '100000000000000001'
const FOUNDER = '100000000000000009'
const OTHER_LEAD_BOT = '100000000000000007'
const STRANGER_BOT = '100000000000000008'
const LEAD = 'flywheel-eng-lead'
const GUILD = '200000000000000001'
const MAIN = '1516209714097291335'
const CORE = '1516209289406971965'
const MIN = 60_000
const HOUR = 60 * MIN
const DAY = 24 * HOUR
const T0 = Date.UTC(2026, 10, 16, 8, 8, 0)
const STATE_DIR = '/state/discord-flywheel-eng-lead'
const STATE_PATH = join(STATE_DIR, STATE_FILE)
const STATUS_PATH = join(STATE_DIR, 'gateway-status.json')

let threadCounter = 0
function idAt(ms: number, n = 0): string {
  return ((BigInt(ms - DISCORD_EPOCH_MS) << 22n) | BigInt(n)).toString()
}
function idAtMs(id: string): number {
  return snowflakeMs(id)
}
function newThreadId(ms: number): string {
  threadCounter += 1
  return idAt(ms, 100 + threadCounter)
}

interface Msg {
  id: string
  channelId: string
  system: boolean
  author: { id: string; bot: boolean }
  content: string
  mentionsSelf: boolean
}

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

function status(code: number): Error & { status: number } {
  return Object.assign(new Error(`HTTP ${code}`), { status: code })
}

class World {
  now: number
  private timerSeq = 0
  private timers: Array<{ id: number; at: number; fn: () => void }> = []
  readonly files = new Map<string, string>()
  readonly channels = new Map<string, { meta: ChannelMeta; messages: Msg[]; requireMention: boolean }>()
  readonly active = new Set<string>()
  readonly calls: string[] = []
  readonly errors = new Map<string, unknown[]>()
  readonly mailbox = new Map<string, number>()
  readonly handled: string[] = []
  readonly failing = new Set<string>()
  readonly blockers = new Map<string, Promise<void>>()
  readonly sleepBlockers: Array<Promise<void>> = []
  readonly logs: string[] = []
  readonly sleeps: number[] = []
  groups: string[] = [MAIN, CORE]
  allowBots: string[] = [OTHER_LEAD_BOT]
  identity = true
  writes = 0
  failWrites = false

  constructor(now = T0) {
    this.now = now
    this.addChannel(MAIN, 'text')
    this.addChannel(CORE, 'text', null, true)
  }

  addChannel(id: string, kind: ChannelMeta['kind'], parentId: string | null = null, requireMention = false,
    archiveTimestamp: number | null = null): string {
    this.channels.set(id, {
      meta: { id, kind, parentId, guildId: GUILD, lastMessageId: null, archiveTimestamp },
      messages: [],
      requireMention,
    })
    return id
  }

  addThread(createdMs: number, opts: { active?: boolean; archivedAt?: number; parent?: string } = {}): string {
    const id = newThreadId(createdMs)
    this.addChannel(id, 'thread', opts.parent ?? MAIN, false, opts.archivedAt ?? createdMs)
    if (opts.active ?? true) this.active.add(id)
    return id
  }

  post(channelId: string, ms: number, opts: Partial<Omit<Msg, 'id' | 'channelId'>> & { n?: number } = {}): Msg {
    const channel = this.channels.get(channelId)!
    const msg: Msg = {
      id: idAt(ms, opts.n ?? channel.messages.length),
      channelId,
      system: opts.system ?? false,
      author: opts.author ?? { id: FOUNDER, bot: false },
      content: opts.content ?? `message at ${ms}`,
      mentionsSelf: opts.mentionsSelf ?? false,
    }
    channel.messages.push(msg)
    channel.messages.sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1))
    channel.meta.lastMessageId = channel.messages[channel.messages.length - 1]!.id
    return msg
  }

  rows(msg: Msg): number {
    return this.mailbox.get(`chat:${LEAD}:${msg.id}`) ?? 0
  }

  handledCount(msg: Msg): number {
    return this.handled.filter(id => id === msg.id).length
  }

  count(prefix: string): number {
    return this.calls.filter(call => call.startsWith(prefix)).length
  }

  state(): CatchupStateV1 {
    return JSON.parse(this.files.get(STATE_PATH)!)
  }

  writeState(state: Partial<CatchupStateV1>): void {
    this.files.set(STATE_PATH, JSON.stringify({
      v: 1, lead: LEAD, updatedAtMs: this.now, liveThroughMs: this.now, nextWindowSeq: 1, windows: [],
      cursors: {}, heard: {}, heardBootstrap: { state: 'done', sinceMs: this.now - 7 * DAY }, ...state,
    }))
  }

  private maybeThrow(key: string): void {
    const queued = this.errors.get(key)
    if (queued && queued.length > 0) throw queued.shift()
  }

  discord(): CatchupDiscord<Msg> {
    const world = this
    return {
      async fetchChannel(id) {
        world.calls.push(`fetchChannel:${id}`)
        world.maybeThrow(`fetchChannel:${id}`)
        const channel = world.channels.get(id)
        if (!channel) throw status(404)
        return { ...channel.meta }
      },
      async fetchActiveThreads(guildId) {
        world.calls.push(`active:${guildId}`)
        world.maybeThrow(`active:${guildId}`)
        return [...world.channels.values()]
          .filter(c => c.meta.kind === 'thread' && world.active.has(c.meta.id))
          .map(c => ({ ...c.meta }))
      },
      async fetchArchivedPublicThreads(channelId, beforeMs) {
        world.calls.push(`archived:${channelId}:${beforeMs ?? ''}`)
        world.maybeThrow(`archived:${channelId}`)
        const all = [...world.channels.values()]
          .filter(c => c.meta.kind === 'thread' && c.meta.parentId === channelId && !world.active.has(c.meta.id))
          .filter(c => beforeMs === undefined || (c.meta.archiveTimestamp ?? 0) < beforeMs)
          .sort((a, b) => (b.meta.archiveTimestamp ?? 0) - (a.meta.archiveTimestamp ?? 0))
        return { threads: all.slice(0, 100).map(c => ({ ...c.meta })), hasMore: all.length > 100 }
      },
      async fetchMessagesAfter(channelId, after, limit) {
        world.calls.push(`messages:${channelId}:${after}`)
        world.maybeThrow(`messages:${channelId}`)
        const channel = world.channels.get(channelId)
        if (!channel) throw status(404)
        return channel.messages.filter(m => BigInt(m.id) > BigInt(after)).slice(0, limit)
      },
    }
  }

  files_(): CatchupFiles {
    return {
      read: path => this.files.get(path),
      write: (path, text) => {
        if (this.failWrites) throw new Error('disk full')
        this.writes += 1
        this.files.set(path, text)
      },
    }
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = ++this.timerSeq
    this.timers.push({ id, at: this.now + ms, fn })
    return id
  }

  clearTimeout(handle: unknown): void {
    this.timers = this.timers.filter(t => t.id !== handle)
  }

  async advance(ms: number): Promise<void> {
    const target = this.now + ms
    for (;;) {
      const due = this.timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (!due) break
      this.timers = this.timers.filter(t => t !== due)
      this.now = Math.max(this.now, due.at)
      due.fn()
      await flush()
    }
    this.now = target
  }

  async handle(msg: Msg): Promise<IntakeOutcome> {
    this.handled.push(msg.id)
    const blocker = this.blockers.get(msg.id)
    if (blocker) await blocker
    const channel = this.channels.get(msg.channelId)
    const parent = channel?.meta.kind === 'thread' ? channel.meta.parentId! : msg.channelId
    if (!this.groups.includes(parent)) return 'done'
    if (this.channels.get(parent)?.requireMention && !msg.mentionsSelf) return 'done'
    if (this.failing.has(msg.id)) return 'failed'
    const key = `chat:${LEAD}:${msg.id}`
    if (!this.mailbox.has(key)) this.mailbox.set(key, 1)
    return 'done'
  }

  start(mode: 'enabled' | 'broken' = 'enabled', leadId: string | undefined = LEAD) {
    let catchup!: InboundCatchup<Msg>
    const pipeline = createIntakePipeline<Msg>({
      tracker: {
        begin: (c, id, live) => catchup.begin(c, id, live),
        finish: (c, id, outcome) => catchup.finish(c, id, outcome),
        noteDone: (c, id) => catchup.noteDone(c, id),
      },
      allowBots: () => this.allowBots,
      identityValid: () => this.identity,
      allowsIntake: authorId => this.identity && authorId !== SELF && authorId !== '',
      handle: msg => this.handle(msg),
      log: line => this.logs.push(line),
    })
    catchup = new InboundCatchup<Msg>({
      mode,
      stateDir: STATE_DIR,
      leadId,
      now: () => this.now,
      log: line => this.logs.push(line),
      groups: () => this.groups,
      discord: this.discord(),
      intake: msg => pipeline.catchupIntake(msg),
      files: this.files_(),
      timers: { setTimeout: (fn, ms) => this.setTimeout(fn, ms), clearTimeout: h => this.clearTimeout(h) },
      sleep: async ms => {
        this.sleeps.push(ms)
        const blocker = this.sleepBlockers.shift()
        if (blocker) await blocker
      },
    })
    const live = (msg: Msg) => {
      const channel = this.channels.get(msg.channelId)
      catchup.noteLive({
        channelId: msg.channelId,
        threadParentId: channel?.meta.kind === 'thread' ? channel.meta.parentId : null,
      })
      return pipeline.intake(msg, 'live')
    }
    const ready = async () => {
      catchup.onConnected()
      await catchup.whenIdle()
    }
    return { catchup, pipeline, live, ready }
  }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}

function windows(world: World): number[] {
  return world.state().windows.map(w => w.seq)
}

describe('FLY-5394 snowflake helpers', () => {
  test('floorSnowflake is strictly below every message at or after the floor', () => {
    const ms = T0 + 1234
    expect(BigInt(floorSnowflake(ms))).toBeLessThan(BigInt(idAt(ms, 0)))
    expect(BigInt(floorSnowflake(ms))).toBeGreaterThanOrEqual(BigInt(idAt(ms - 1, 4_194_303)))
    expect(snowflakeMs(idAt(ms, 77))).toBe(ms)
  })
})

describe('FLY-5394 catch-up after a gateway gap', () => {
  test('T1 reproduces the incident: a 78 s restart gap is delivered once in the main channel and the thread', async () => {
    const world = new World(T0 - 30 * MIN)
    const thread = world.addThread(T0 - 20 * MIN)
    const oldMain = world.post(MAIN, T0 - 10 * MIN)
    const oldThread = world.post(thread, T0 - 9 * MIN)
    const earlier = world.post(MAIN, T0 - 60 * 1000)
    world.mailbox.set(`chat:${LEAD}:${earlier.id}`, 1)
    world.now = T0 + 78_000
    world.writeState({
      liveThroughMs: T0, cursors: { [MAIN]: oldMain.id, [thread]: oldThread.id }, heard: { [thread]: T0 - HOUR },
    })
    const gapMain = world.post(MAIN, T0 + 30_000)
    const gapThread = world.post(thread, T0 + 54_000)
    const { ready } = world.start()
    expect(world.state().windows).toEqual([
      expect.objectContaining({ cause: 'startup', floorMs: T0 - CATCHUP_LIMITS.marginMs }),
    ])
    await ready()
    expect(world.rows(gapMain)).toBe(1)
    expect(world.rows(gapThread)).toBe(1)
    expect(world.rows(earlier)).toBe(1)
    expect(world.handledCount(oldMain)).toBe(0)
    expect(world.handledCount(oldThread)).toBe(0)
    expect(world.state().windows).toEqual([])
    expect(world.state().cursors[MAIN]).toBe(gapMain.id)
    expect(world.state().cursors[thread]).toBe(gapThread.id)
    expect(world.logs.some(l => l.startsWith('inbound-catchup done'))).toBe(true)
  })

  test('T2 live and catch-up meeting the same message run handleInbound once', async () => {
    const world = new World()
    world.writeState({ liveThroughMs: T0 })
    const thread = world.addThread(T0 - HOUR)
    const g = world.post(thread, T0 + 10_000)
    world.now = T0 + 60_000
    const gate = deferred()
    world.blockers.set(g.id, gate.promise)
    const { catchup, live } = world.start()
    const fromLive = live(g)
    catchup.onConnected()
    await flush()
    gate.resolve()
    expect(await fromLive).toBe('done')
    await catchup.whenIdle()
    expect(world.handledCount(g)).toBe(1)
    expect(world.rows(g)).toBe(1)
    expect(world.state().windows).toEqual([])
  })

  test('T3 a message already ingested by the previous process is registered once and the cursor advances', async () => {
    const world = new World()
    const g = world.post(MAIN, T0 - 30_000)
    world.mailbox.set(`chat:${LEAD}:${g.id}`, 1)
    world.writeState({ liveThroughMs: T0 })
    world.now = T0 + MIN
    await world.start().ready()
    expect(world.rows(g)).toBe(1)
    expect(world.handledCount(g)).toBe(1)
    expect(world.state().cursors[MAIN]).toBe(g.id)
  })

  test('T4 first upgrade uses the previous gateway-status lastAckAt', async () => {
    const world = new World()
    const t1 = T0
    world.files.set(STATUS_PATH, JSON.stringify({ lead: LEAD, shards: [{ shardId: 0, lastAckAt: t1 }] }))
    const tooOld = world.post(MAIN, t1 - 200_000)
    const inWindow = world.post(MAIN, t1 - 60_000)
    world.now = t1 + 78_000
    const { ready } = world.start()
    expect(world.state().windows[0]).toMatchObject({ cause: 'startup', floorMs: t1 - 120_000 })
    expect(world.state().heardBootstrap.state).toBe('pending')
    await ready()
    expect(world.handledCount(tooOld)).toBe(0)
    expect(world.rows(inWindow)).toBe(1)
  })

  test.each([
    ['no files', (_w: World) => {}],
    ['mismatched gateway-status lead', (w: World) => {
      w.files.set(STATUS_PATH, JSON.stringify({ lead: 'other-lead', shards: [{ lastAckAt: T0 }] }))
    }],
    ['corrupt state and status without ack', (w: World) => {
      w.files.set(STATE_PATH, '{not json')
      w.files.set(STATUS_PATH, JSON.stringify({ lead: LEAD, shards: [{ lastAckAt: null }] }))
    }],
  ])('T5 without evidence (%s) only the last 15 minutes are read', async (_name, setup) => {
    const world = new World()
    setup(world)
    const twenty = world.post(MAIN, T0 - 20 * MIN)
    const ten = world.post(MAIN, T0 - 10 * MIN)
    const { ready } = world.start()
    expect(world.state().windows[0]).toMatchObject({ cause: 'startup_no_evidence', floorMs: T0 - 15 * MIN })
    await ready()
    expect(world.handledCount(twenty)).toBe(0)
    expect(world.rows(ten)).toBe(1)
  })

  test('T6 a long evidenced outage is never truncated', async () => {
    const world = new World(T0 - 31 * HOUR)
    const cursor = world.post(MAIN, T0 - 31 * HOUR)
    const messages: Msg[] = []
    for (let i = 0; i < 250; i++) messages.push(world.post(MAIN, T0 - 30 * HOUR + i * 7 * MIN))
    world.now = T0
    world.writeState({ liveThroughMs: T0 - 30 * HOUR, cursors: { [MAIN]: cursor.id } })
    await world.start().ready()
    expect(messages.every(m => world.rows(m) === 1)).toBe(true)
    expect(world.count(`messages:${MAIN}`)).toBe(3)
    expect(world.state().windows).toEqual([])
  })

  test('T7 the persist barrier keeps a thread cursor behind an unread gap message after newer live progress', async () => {
    const world = new World()
    const thread = world.addThread(T0 - HOUR)
    const before = world.post(thread, T0 - 5 * MIN)
    world.writeState({ liveThroughMs: T0, cursors: { [thread]: before.id }, heard: { [thread]: T0 } })
    const g = world.post(thread, T0 + 20_000)
    world.now = T0 + 80_000
    const first = world.start()
    const l = world.post(thread, T0 + 90_000)
    world.now = T0 + 90_000
    expect(await first.live(l)).toBe('done')
    first.catchup.noteAck(world.now)
    await world.advance(5_000)
    const frozen = world.state().cursors[thread]
    expect(frozen === undefined || BigInt(frozen) < BigInt(g.id)).toBe(true)
    expect(world.state().windows).toHaveLength(1)
    // crash: only the state file survives
    const second = world.start()
    await second.ready()
    expect(world.rows(g)).toBe(1)
    expect(world.rows(l)).toBe(1)
    expect(world.state().cursors[thread]).toBe(l.id)
    expect(world.state().windows).toEqual([])
  })

  test('T8 a non-durable catch-up intake is retried for real in the same process', async () => {
    const world = new World()
    const before = world.post(MAIN, T0 - 5 * MIN)
    world.writeState({ liveThroughMs: T0, cursors: { [MAIN]: before.id } })
    const g = world.post(MAIN, T0 + 20_000)
    const after = world.post(MAIN, T0 + 30_000)
    world.failing.add(g.id)
    world.now = T0 + MIN
    const { catchup, ready } = world.start()
    await ready()
    expect(world.rows(g)).toBe(0)
    expect(world.rows(after)).toBe(1)
    const pinned = world.state().cursors[MAIN]
    expect(pinned === undefined || BigInt(pinned) < BigInt(g.id)).toBe(true)
    expect(world.state().windows.map(w => w.cause)).toEqual(['startup', 'failure'])
    world.failing.delete(g.id)
    await world.advance(30_000)
    await catchup.whenIdle()
    expect(world.handledCount(g)).toBe(2)
    expect(world.handledCount(after)).toBe(1)
    expect(world.rows(g)).toBe(1)
    expect(world.state().windows).toEqual([])
    expect(world.state().cursors[MAIN]).toBe(after.id)
  })

  test('T8b a failed live intake opens a durable window; a run in progress does not close it', async () => {
    const world = new World()
    world.writeState({ liveThroughMs: T0 })
    world.now = T0 + MIN
    const { catchup, live, ready } = world.start()
    await ready()
    expect(world.state().windows).toEqual([])
    const h = world.post(MAIN, world.now)
    world.failing.add(h.id)
    expect(await live(h)).toBe('failed')
    expect(world.state().windows).toEqual([expect.objectContaining({ cause: 'failure', floorMs: world.now - 1 })])
    world.failing.delete(h.id)
    await world.advance(30_000)
    await catchup.whenIdle()
    expect(world.rows(h)).toBe(1)
    expect(world.state().windows).toEqual([])

    // A second failure while a run is still working: the run only closes what it owned.
    const thread = world.addThread(world.now)
    const g = world.post(thread, world.now)
    const gate = deferred()
    world.blockers.set(g.id, gate.promise)
    catchup.onDisconnected()
    world.now += 10_000
    catchup.onConnected()
    await flush()
    const h2 = world.post(MAIN, world.now)
    world.failing.add(h2.id)
    expect(await live(h2)).toBe('failed')
    const failureSeq = world.state().windows.find(w => w.cause === 'failure')!.seq
    gate.resolve()
    await catchup.whenIdle()
    expect(world.state().windows.map(w => w.seq)).toEqual([failureSeq])
    world.failing.delete(h2.id)
    await world.advance(CATCHUP_LIMITS.failureBackoffMs[0])
    await catchup.whenIdle()
    expect(world.rows(h2)).toBe(1)
    expect(world.state().windows).toEqual([])
  })

  test('T9 archived public threads: read those archived inside the window, page until the floor', async () => {
    const world = new World()
    world.writeState({ liveThroughMs: T0 })
    const inside: string[] = []
    for (let i = 0; i < 100; i++) inside.push(world.addThread(T0 - DAY, { active: false, archivedAt: T0 + 10_000 + i }))
    const g = world.post(inside[5]!, T0 + 5_000)
    world.channels.get(inside[5]!)!.meta.archiveTimestamp = T0 + 50_000
    const outside = world.addThread(T0 - DAY, { active: false, archivedAt: T0 - 10 * MIN })
    world.post(outside, T0 - 2 * DAY)
    world.now = T0 + MIN
    await world.start().ready()
    expect(world.rows(g)).toBe(1)
    expect(world.count(`archived:${MAIN}`)).toBe(2)
    expect(world.count(`messages:${outside}`)).toBe(0)
    expect(world.count(`fetchChannel:${outside}`)).toBe(0)
    expect(world.count('messages:')).toBe(1)
  })

  test('T10 catch-up uses the same admission chain as the live callback', async () => {
    const world = new World()
    world.writeState({ liveThroughMs: T0 })
    const batch = [
      world.post(MAIN, T0 + 1_000, { author: { id: SELF, bot: true } }),
      world.post(MAIN, T0 + 2_000, { system: true }),
      world.post(MAIN, T0 + 3_000, { author: { id: STRANGER_BOT, bot: true } }),
      world.post(CORE, T0 + 4_000),
      world.post(CORE, T0 + 5_000, { author: { id: OTHER_LEAD_BOT, bot: true }, mentionsSelf: true }),
      world.post(MAIN, T0 + 6_000),
    ]
    world.now = T0 + MIN
    await world.start().ready()
    const catchupHandled = [...world.handled]
    const catchupRows = batch.map(m => world.rows(m))

    // The same batch through the real live callback in a fresh world.
    const liveWorld = new World()
    liveWorld.writeState({ liveThroughMs: T0 })
    for (const m of batch) liveWorld.post(m.channelId, snowflakeMs(m.id), { ...m, n: Number(BigInt(m.id) & 0xfffn) })
    const { catchup, pipeline } = liveWorld.start()
    const client = Object.assign(new EventEmitter(), { user: { id: SELF }, isReady: () => true })
    const filter = new SelfAuthorFilter()
    attachSelfAuthorFilter<Msg>(client, filter, {
      onSelfEcho: msg => catchup.noteDone(msg.channelId, msg.id),
      onOther: msg => { void pipeline.intake(msg, 'live') },
      log: () => {},
    })
    client.emit('ready')
    for (const m of batch) client.emit('messageCreate', m)
    await flush()
    expect(liveWorld.handled).toEqual(catchupHandled)
    expect(batch.map(m => liveWorld.rows(m))).toEqual(catchupRows)
    expect(catchupRows).toEqual([0, 0, 0, 0, 1, 1])
  })

  test('T12 a new session message before shardReady does not move the disconnect window floor', async () => {
    const world = new World()
    world.writeState({ liveThroughMs: T0 })
    world.now = T0 + MIN
    const { catchup, live, ready } = world.start()
    await ready()
    const t0 = world.now
    await live(world.post(MAIN, t0))
    world.now = t0 + 10_000
    catchup.onDisconnected()
    const g = world.post(world.addThread(t0 + 20_000), t0 + 60_000)
    world.now = t0 + 5 * MIN
    const h = world.post(MAIN, world.now)
    await live(h)
    expect(world.state().windows).toEqual([expect.objectContaining({ cause: 'disconnect', floorMs: t0 - 120_000 })])
    await ready()
    expect(world.rows(g)).toBe(1)
    expect(world.rows(h)).toBe(1)
    expect(world.state().windows).toEqual([])
  })

  test('T12b an old run never closes a window opened while it was working', async () => {
    const world = new World()
    const slow = world.addThread(T0 - HOUR)
    world.writeState({ liveThroughMs: T0, heard: { [slow]: T0 } })
    world.post(slow, T0 + 1_000)
    world.now = T0 + MIN
    const retry = deferred()
    world.sleepBlockers.push(retry.promise)
    world.errors.set(`messages:${slow}`, [status(500)])
    const { catchup, live } = world.start()
    catchup.onConnected()
    await flush()
    expect(world.sleeps).toEqual([5_000])
    await live(world.post(MAIN, world.now))
    catchup.onDisconnected()
    world.now += 30_000
    const g2 = world.post(MAIN, world.now)
    world.now += 30_000
    catchup.onConnected()
    retry.resolve()
    await catchup.whenIdle()
    expect(world.logs.some(l => l.includes('disconnected_during_run'))).toBe(true)
    expect(world.rows(g2)).toBe(1)
    expect(world.state().windows).toEqual([])
    const opens = world.logs.filter(l => l.startsWith('inbound-catchup window_open')).length
    const closes = world.logs.filter(l => l.startsWith('inbound-catchup window_close')).length
    expect(opens).toBe(2)
    expect(closes).toBe(2)
  })

  test('T12c a resume replay still in flight bounds durable evidence; the next process re-reads it', async () => {
    const world = new World()
    world.writeState({ liveThroughMs: T0 })
    world.now = T0 + MIN
    const first = world.start()
    await first.ready()
    await first.live(world.post(MAIN, world.now))
    world.now += 10_000
    first.catchup.onDisconnected()
    const thread = world.addThread(world.now)
    const g = world.post(thread, world.now + 30_000)
    world.now += 5 * MIN
    const gate = deferred()
    world.blockers.set(g.id, gate.promise)
    first.catchup.onConnected()
    const replay = first.live(g)
    const receivedAt = world.now
    world.now += 3 * MIN
    first.catchup.noteAck(world.now)
    await world.advance(2_000)
    expect(world.state().liveThroughMs).toBe(receivedAt)
    expect(world.state().windows.map(w => w.cause)).toEqual(['disconnect'])
    // crash before G is durable
    void replay
    world.blockers.delete(g.id)
    const second = world.start()
    expect(Math.min(...world.state().windows.map(w => w.floorMs))).toBeLessThan(snowflakeMs(g.id))
    await second.ready()
    expect(world.rows(g)).toBe(1)
  })

  test('T12d a normal resume triggers a run that merges replayed messages and closes the window', async () => {
    const world = new World()
    world.writeState({ liveThroughMs: T0 })
    world.now = T0 + MIN
    const { catchup, live, ready } = world.start()
    await ready()
    await live(world.post(MAIN, world.now))
    catchup.onDisconnected()
    const g = world.post(MAIN, world.now + 5_000)
    world.now += 20_000
    await live(g)
    await ready()
    expect(world.handledCount(g)).toBe(1)
    expect(world.rows(g)).toBe(1)
    expect(world.state().windows).toEqual([])
  })

  test('T12e a rerun never starts while the gateway is still disconnected', async () => {
    const world = new World()
    const thread = world.addThread(T0 - HOUR)
    world.writeState({ liveThroughMs: T0, heard: { [thread]: T0 } })
    const g1 = world.post(thread, T0 + 1_000)
    world.now = T0 + MIN
    const gate = deferred()
    world.blockers.set(g1.id, gate.promise)
    const { catchup, ready } = world.start()
    catchup.onConnected()
    await flush()
    catchup.onDisconnected()
    gate.resolve()
    await catchup.whenIdle()
    const callsWhileDown = world.calls.length
    const g = world.post(MAIN, world.now + 10_000)
    await world.advance(15 * MIN)
    expect(world.calls.length).toBe(callsWhileDown)
    expect(world.state().windows.map(w => w.cause)).toEqual(['startup', 'disconnect'])
    await ready()
    expect(world.rows(g)).toBe(1)
    expect(world.state().windows).toEqual([])
  })

  test.each([
    ['missing FLYWHEEL_LEAD_ID with old state', undefined, true],
    ['missing FLYWHEEL_LEAD_ID without state', undefined, false],
    ['missing comm wiring with old state', LEAD, true],
    ['missing comm wiring without state', LEAD, false],
  ])('T13b broken mode (%s) keeps windows open without reading; the next enabled process delivers the gap', async (_name, brokenLead, withState) => {
    const world = new World()
    if (withState) world.writeState({ liveThroughMs: T0, lead: null })
    world.now = T0 + MIN
    const broken = world.start('broken', brokenLead)
    broken.catchup.onConnected()
    await broken.catchup.whenIdle()
    const thread = world.addThread(world.now)
    const held = world.post(thread, world.now)
    await broken.live(held)
    world.failing.add('held-write')
    broken.catchup.finish(MAIN, world.post(MAIN, world.now + 1).id, 'failed')
    broken.catchup.onDisconnected()
    const gapOld = world.post(MAIN, world.now + 2 * MIN)
    world.now += 40 * MIN
    expect(world.calls).toEqual([])
    expect(world.state().windows.map(w => w.cause)).toEqual([
      withState ? 'startup' : 'startup_no_evidence', 'failure', 'disconnect',
    ])
    expect(world.state().heard[thread]).toBeDefined()
    const enabled = world.start('enabled', LEAD)
    await enabled.ready()
    expect(world.rows(gapOld)).toBe(1)
    expect(world.rows(held)).toBe(1)
    expect(world.state().windows).toEqual([])
    expect(world.state().lead).toBe(LEAD)
  })

  test('T14 REST errors: transient retry, 404, 403, guild unavailable and identity closure', async () => {
    const world = new World()
    const gone = world.addThread(T0 - HOUR)
    const forbidden = world.addThread(T0 - HOUR)
    world.writeState({ liveThroughMs: T0, heard: { [gone]: T0, [forbidden]: T0 } })
    world.channels.delete(gone)
    world.post(forbidden, T0 + 1_000)
    world.errors.set(`messages:${forbidden}`, [status(403)])
    const g = world.post(MAIN, T0 + 2_000)
    world.errors.set(`messages:${MAIN}`, [status(500), status(502)])
    world.now = T0 + MIN
    await world.start().ready()
    expect(world.sleeps).toEqual([5_000, 30_000])
    expect(world.rows(g)).toBe(1)
    expect(world.logs.some(l => l === `inbound-catchup skipped_forbidden channel=${forbidden}`)).toBe(true)
    expect(world.state().windows).toEqual([])

    const unavailable = new World()
    unavailable.writeState({ liveThroughMs: T0 })
    unavailable.errors.set(`active:${GUILD}`, [new Error('guild_unavailable'), new Error('x'), new Error('y'), new Error('z')])
    unavailable.now = T0 + MIN
    await unavailable.start().ready()
    expect(unavailable.state().windows).toHaveLength(1)
    expect(unavailable.logs.some(l => l.includes('reason=active_listing'))).toBe(true)

    const closed = new World()
    closed.writeState({ liveThroughMs: T0 })
    const c = closed.post(MAIN, T0 + 1_000)
    closed.identity = false
    closed.now = T0 + MIN
    await closed.start().ready()
    expect(closed.handledCount(c)).toBe(0)
    expect(closed.state().windows).toHaveLength(1)
    expect(closed.logs.some(l => l.includes('identity_closed'))).toBe(true)
  })

  test.each([
    ['lead differs', { lead: 'other-lead' }],
    ['non-numeric cursor', { cursors: { [MAIN]: 'abc' } }],
    ['seq not below nextWindowSeq', { nextWindowSeq: 1, windows: [{ seq: 1, floorMs: T0, cause: 'startup', openedAtMs: T0 }] }],
    ['too many windows', { nextWindowSeq: 40, windows: Array.from({ length: 33 }, (_, i) => ({ seq: i + 1, floorMs: T0, cause: 'startup', openedAtMs: T0 })) }],
  ])('T15 an invalid state file (%s) is ignored and replaced', async (_name, patch) => {
    const world = new World()
    world.writeState({ liveThroughMs: T0 - 5 * MIN, ...(patch as Partial<CatchupStateV1>) })
    world.files.set(STATUS_PATH, JSON.stringify({ lead: LEAD, shards: [{ lastAckAt: T0 }] }))
    world.now = T0 + MIN
    world.start()
    expect(world.logs.some(l => l.startsWith('inbound-catchup state_invalid'))).toBe(true)
    expect(world.state().windows).toEqual([expect.objectContaining({ floorMs: T0 - 120_000 })])
    expect(world.state().lead).toBe(LEAD)
  })

  test('T15 a valid state file wins over a newer gateway-status file', () => {
    const world = new World()
    world.writeState({ liveThroughMs: T0 - 5 * MIN })
    world.files.set(STATUS_PATH, JSON.stringify({ lead: LEAD, shards: [{ lastAckAt: T0 }] }))
    world.now = T0 + MIN
    world.start()
    expect(world.state().windows[0]!.floorMs).toBe(T0 - 5 * MIN - 120_000)
  })

  test('T15 parseCatchupState treats a missing bootstrap as pending', () => {
    const parsed = parseCatchupState(JSON.stringify({
      v: 1, lead: null, updatedAtMs: T0, liveThroughMs: T0, nextWindowSeq: 1, windows: [], cursors: {}, heard: {},
    }), LEAD, T0)
    expect(parsed).toMatchObject({ ok: true, value: { heardBootstrap: { state: 'pending', sinceMs: T0 - 7 * DAY } } })
    expect(parseCatchupState('x'.repeat(CATCHUP_LIMITS.fileMaxBytes + 1), LEAD, T0)).toMatchObject({ ok: false, reason: 'too_large' })
  })

  test('T16 pagination: full pages continue, short pages stop, backward pages abandon the channel', async () => {
    const world = new World()
    world.writeState({ liveThroughMs: T0 })
    const thread = world.addThread(T0 - HOUR)
    world.post(thread, T0 + 1_000)
    const messages: Msg[] = []
    for (let i = 0; i < 250; i++) messages.push(world.post(MAIN, T0 + 2_000 + i * 100))
    world.now = T0 + MIN
    await world.start().ready()
    expect(world.count(`messages:${MAIN}`)).toBe(3)
    expect(messages.every(m => world.rows(m) === 1)).toBe(true)

    const backward = new World()
    backward.writeState({ liveThroughMs: T0 })
    const before = backward.post(MAIN, T0 - 10 * MIN)
    backward.post(MAIN, T0 + 1_000)
    const disc = backward.discord()
    backward.now = T0 + MIN
    const run = backward.start()
    // Serve a page that contains the cursor itself.
    ;(run.catchup as unknown as { opts: { discord: CatchupDiscord<Msg> } }).opts.discord = {
      ...disc,
      fetchMessagesAfter: async () => [before],
    }
    await run.ready()
    expect(backward.logs.some(l => l.startsWith(`inbound-catchup page_not_forward channel=${MAIN}`))).toBe(true)
    expect(backward.state().windows).toHaveLength(1)
  })

  test('T16 shutdown on page 3 resumes from durable progress without reprocessing pages 1-2', async () => {
    const world = new World()
    world.writeState({ liveThroughMs: T0 })
    const messages: Msg[] = []
    for (let i = 0; i < 250; i++) messages.push(world.post(MAIN, T0 + 2_000 + i * 100))
    world.now = T0 + MIN
    const stopAt = messages[205]!
    const gate = deferred()
    world.blockers.set(stopAt.id, gate.promise)
    const first = world.start()
    first.catchup.onConnected()
    for (let i = 0; i < 200 && world.handledCount(stopAt) === 0; i++) await flush()
    expect(world.handledCount(stopAt)).toBe(1)
    first.catchup.shutdown()
    gate.resolve()
    await first.catchup.whenIdle()
    expect(world.state().windows).toHaveLength(1)
    expect(world.state().cursors[MAIN]).toBe(messages[204]!.id)
    world.blockers.clear()
    await world.start().ready()
    expect(messages.slice(0, 205).every(m => world.handledCount(m) === 1)).toBe(true)
    expect(messages.every(m => world.rows(m) === 1)).toBe(true)
    expect(world.state().windows).toEqual([])
  })

  test('T17 pruning drops cursors older than every floor, caps cursors and merges windows', async () => {
    const world = new World()
    const cursors: Record<string, string> = {}
    for (let i = 0; i < 4999; i++) cursors[idAt(T0 - DAY, i)] = idAt(T0 - 30 * MIN, i)
    cursors[MAIN] = idAt(T0 - 3 * HOUR)
    world.writeState({ liveThroughMs: T0 - HOUR, cursors })
    world.now = T0
    const { catchup, ready } = world.start()
    expect(world.state().cursors[MAIN]).toBeUndefined()
    expect(Object.keys(world.state().cursors)).toHaveLength(4999)
    await ready()
    const oldest = idAt(T0 - 50 * MIN)
    catchup.noteDone('300000000000000001', idAt(T0 - MIN))
    catchup.noteDone('300000000000000002', oldest)
    await world.advance(2_000)
    expect(Object.keys(world.state().cursors)).toHaveLength(CATCHUP_LIMITS.cursorsMax)
    expect(world.state().cursors['300000000000000002']).toBeUndefined()
    for (let i = 0; i < 40; i++) catchup.finish(MAIN, idAt(T0 - i * MIN, 9), 'failed')
    const merged = world.state().windows
    expect(merged).toHaveLength(8)
    expect(merged[0]).toMatchObject({ cause: 'merged', floorMs: idAtMs(idAt(T0 - 32 * MIN, 9)) - 1 })
    expect(Math.min(...merged.map(w => w.floorMs))).toBe(T0 - 39 * MIN - 1)
    expect(merged.every(w => w.seq <= world.state().nextWindowSeq - 1)).toBe(true)
  })

  test('T21 a raw THREAD_UPDATE for an uncached thread joins the catch-up set through the real discord.js dispatch path', async () => {
    const world = new World()
    world.writeState({ liveThroughMs: T0 })
    const thread = world.addThread(T0 - 2 * DAY, { active: false, archivedAt: T0 - 2 * DAY })
    const g = world.post(thread, T0 + 10_000)
    world.now = T0 + MIN
    const { catchup, ready } = world.start()
    const client = new Client({ intents: [] })
    const ws = client.ws as unknown as { _ws: EventEmitter; attachEvents(): void; shards: Map<number, unknown>; status: number }
    ws._ws = Object.assign(new EventEmitter(), { destroy: async () => {} })
    ws.attachEvents()
    ws.shards.set(0, { status: 0, id: 0 })
    ws.status = 0
    let publicUpdates = 0
    client.on(Events.ThreadUpdate, () => { publicUpdates += 1 })
    client.on(Events.Raw, packet => catchup.noteRaw(packet))
    try {
      ws._ws.emit('dispatch', { shardId: 0, data: { op: 0, s: 2, t: 'THREAD_UPDATE', d: { id: thread, parent_id: MAIN, guild_id: GUILD, type: 11 } } })
    } catch {}
    expect(publicUpdates).toBe(0)
    expect(catchup.touchedIds()).toEqual([thread])
    await ready()
    expect(world.rows(g)).toBe(1)
    void client.destroy()
  })

  test('T21b a recently-heard thread is read by id even when every listing misses it', async () => {
    const world = new World()
    const thread = world.addThread(T0 - 3 * DAY, { active: false, archivedAt: T0 - 3 * DAY })
    world.writeState({ liveThroughMs: T0, heard: { [thread]: T0 - 2 * DAY } })
    const g = world.post(thread, T0 + 10_000)
    world.now = T0 + MIN
    await world.start().ready()
    expect(world.count(`fetchChannel:${thread}`)).toBe(1)
    expect(world.rows(g)).toBe(1)
  })

  test('T21c heard entries survive 7.5 days and expire after 8', async () => {
    const world = new World()
    const recent = world.addThread(T0 - 10 * DAY, { active: false, archivedAt: T0 - 10 * DAY })
    const expired = world.addThread(T0 - 10 * DAY, { active: false, archivedAt: T0 - 10 * DAY })
    world.writeState({ liveThroughMs: T0, heard: { [recent]: T0 - 7.5 * DAY, [expired]: T0 - 9 * DAY } })
    world.now = T0 + MIN
    await world.start().ready()
    expect(world.count(`fetchChannel:${recent}`)).toBe(1)
    expect(world.count(`fetchChannel:${expired}`)).toBe(0)
  })

  test('T21d heard threads already in the active listing cost no extra request', async () => {
    const world = new World()
    const heard: Record<string, number> = {}
    for (let i = 0; i < 150; i++) {
      const id = world.addThread(T0 - DAY, { active: i < 100, archivedAt: T0 - DAY })
      heard[id] = T0 - HOUR
    }
    world.writeState({ liveThroughMs: T0, heard })
    world.now = T0 + MIN
    await world.start().ready()
    expect(world.count('fetchChannel:')).toBe(2 + 50)
  })

  test.each(['broken process', 'failed cursor pinned in the past', 'cursor evicted by the cap'])(
    'T21e heard is independent of cursors: %s', async scenario => {
      const world = new World()
      const thread = world.addThread(T0 - 9 * DAY, { active: false, archivedAt: T0 - 9 * DAY })
      if (scenario === 'broken process') {
        world.writeState({ liveThroughMs: T0 - HOUR })
        world.now = T0 - 30 * MIN
        const broken = world.start('broken')
        await broken.live(world.post(thread, world.now))
      } else if (scenario === 'failed cursor pinned in the past') {
        world.writeState({ liveThroughMs: T0, cursors: { [thread]: idAt(T0 - 8 * DAY) }, heard: { [thread]: T0 - DAY } })
      } else {
        const cursors: Record<string, string> = {}
        for (let i = 0; i < 4999; i++) cursors[idAt(T0 - 10 * MIN, i)] = idAt(T0 - 5 * MIN, i)
        cursors[thread] = idAt(T0 - 50 * MIN)
        world.writeState({ liveThroughMs: T0 - HOUR, cursors, heard: { [thread]: T0 - DAY } })
        world.now = T0
        const first = world.start()
        await first.ready()
        first.catchup.noteDone(CORE, idAt(T0 - MIN))
        first.catchup.noteDone(MAIN, idAt(T0 - MIN, 1))
        await world.advance(2_000)
        expect(world.state().cursors[thread]).toBeUndefined()
        expect(world.state().heard[thread]).toBe(T0 - DAY)
      }
      const g = world.post(thread, T0 + 10_000)
      world.now = T0 + MIN
      await world.start().ready()
      expect(world.rows(g)).toBe(1)
    })

  test('T21f first upgrade bootstraps heard from active and 7-day archived listings', async () => {
    const world = new World()
    const a = world.addThread(T0 - DAY)
    world.post(a, T0 - 3 * HOUR)
    const b = world.addThread(T0 - 5 * DAY, { active: false, archivedAt: T0 - 2 * DAY })
    world.post(b, T0 - 2 * DAY - HOUR)
    const c = world.addThread(T0 - 10 * DAY, { active: false, archivedAt: T0 - 8 * DAY })
    world.now = T0
    const first = world.start()
    await first.ready()
    expect(world.state().heardBootstrap.state).toBe('done')
    expect(Object.keys(world.state().heard).sort()).toEqual([a, b].sort())
    expect(world.state().heard[c]).toBeUndefined()
    expect(world.logs).toContain('inbound-catchup heard_bootstrap threads=2')
    first.catchup.onDisconnected()
    const g = world.post(b, world.now + 10_000)
    world.channels.get(b)!.meta.archiveTimestamp = T0 - 2 * DAY
    world.now += MIN
    await first.ready()
    expect(world.rows(g)).toBe(1)
  })

  test.each(['crash before the first run', 'broken first start', 'archived listing fails'])(
    'T21g the bootstrap obligation survives: %s', async scenario => {
      const world = new World()
      const t = world.addThread(T0 - 3 * DAY, { active: false, archivedAt: T0 - DAY })
      world.now = T0
      if (scenario === 'crash before the first run') {
        world.start()
      } else if (scenario === 'broken first start') {
        const broken = world.start('broken')
        broken.catchup.onConnected()
        await broken.catchup.whenIdle()
        expect(world.calls).toEqual([])
      } else {
        world.errors.set(`archived:${MAIN}`, [status(500), status(500), status(500), status(500)])
        await world.start().ready()
        expect(world.state().windows).toHaveLength(1)
        world.calls.length = 0
      }
      expect(world.state().heardBootstrap.state).toBe('pending')
      world.now += HOUR
      await world.start().ready()
      expect(world.state().heardBootstrap.state).toBe('done')
      expect(world.state().heard[t]).toBeDefined()
      expect(world.state().windows).toEqual([])
    })

  test('T21h a debounced heard refresh lost in a crash still keeps the thread for 7 days', async () => {
    const world = new World()
    const thread = world.addThread(T0 - 30 * DAY, { active: false, archivedAt: T0 - 30 * DAY })
    world.writeState({ liveThroughMs: T0, heard: { [thread]: T0 - 20 * HOUR } })
    world.now = T0
    const first = world.start()
    await first.live(world.post(thread, T0))
    expect(world.state().heard[thread]).toBe(T0 - 20 * HOUR)
    world.now = T0 + 6.5 * DAY
    const g = world.post(thread, T0 + 6 * DAY)
    await world.start().ready()
    expect(world.rows(g)).toBe(1)
  })

  test('T22 a slow local clock cannot persist a thread cursor past an unread gap message', async () => {
    const world = new World()
    world.writeState({ liveThroughMs: T0 })
    const discordNow = T0 + 2 * MIN
    world.now = discordNow - 60_000
    const thread = world.addThread(discordNow - 30_000)
    const g = world.post(thread, discordNow - 20_000)
    const first = world.start()
    const l = world.post(thread, discordNow + 5_000)
    await first.live(l)
    await world.advance(5_000)
    const cursor = world.state().cursors[thread]
    expect(cursor === undefined || BigInt(cursor) < BigInt(g.id)).toBe(true)
    await world.start().ready()
    expect(world.rows(g)).toBe(1)
  })
})

describe('FLY-5394 once-per-message intake', () => {
  test('HandledOnce shares in-flight calls and successes but never caches failures', async () => {
    const once = new HandledOnce(2)
    let runs = 0
    const gate = deferred<IntakeOutcome>()
    const a = once.run('1', () => { runs += 1; return gate.promise })
    const b = once.run('1', async () => { runs += 1; return 'done' })
    gate.resolve('failed')
    expect(await a).toBe('failed')
    expect(await b).toBe('failed')
    expect(runs).toBe(1)
    expect(await once.run('1', async () => { runs += 1; return 'done' })).toBe('done')
    expect(await once.run('1', async () => { runs += 1; return 'failed' })).toBe('done')
    expect(runs).toBe(2)
    await once.run('2', async () => 'done')
    await once.run('3', async () => 'done')
    expect(await once.run('1', async () => { runs += 1; return 'done' })).toBe('done')
    expect(runs).toBe(3)
  })

  test('a thrown handleInbound is a failure and is retried on the next attempt', async () => {
    let calls = 0
    const finished: string[] = []
    const pipeline = createIntakePipeline({
      tracker: { begin() {}, finish: (_c, id, outcome) => finished.push(`${id}:${outcome}`), noteDone() {} },
      allowBots: () => [],
      identityValid: () => true,
      allowsIntake: () => true,
      handle: async () => { calls += 1; if (calls === 1) throw new Error('boom'); return 'done' },
      log: () => {},
    })
    const msg = { id: '1', channelId: 'c', system: false, author: { id: 'u', bot: false } }
    expect(await pipeline.intake(msg, 'live')).toBe('failed')
    expect(await pipeline.catchupIntake(msg)).toBe('done')
    expect(finished).toEqual(['1:failed', '1:done'])
  })
})

describe('FLY-5394 state file on disk', () => {
  test('nodeCatchupFiles writes owner-only files atomically', () => {
    const dir = mkdtempSync(join(tmpdir(), 'fly5394-'))
    try {
      const path = join(dir, 'nested', STATE_FILE)
      expect(nodeCatchupFiles.read(path)).toBeUndefined()
      nodeCatchupFiles.write(path, '{"v":1}\n')
      nodeCatchupFiles.write(path, '{"v":2}\n')
      expect(readFileSync(path, 'utf8')).toBe('{"v":2}\n')
      expect(statSync(path).mode & 0o777).toBe(0o600)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('FLY-5394 code review round 1 fixes', () => {
  test('F1 an unwritten startup window keeps the previous gateway evidence usable after a crash', async () => {
    const world = new World()
    world.files.set(STATUS_PATH, JSON.stringify({ lead: LEAD, shards: [{ lastAckAt: T0 - 3 * HOUR }] }))
    const old = world.post(MAIN, T0 - 2 * HOUR)
    world.now = T0
    world.failWrites = true
    const first = world.start()
    expect(first.catchup.startupPersisted()).toBe(false)
    expect(world.files.has(STATE_PATH)).toBe(false)
    expect(world.logs).toContain('inbound-catchup state_write_failed error=disk full')
    // crash; the previous gateway-status.json was not overwritten
    world.failWrites = false
    const second = world.start()
    expect(world.state().windows[0]!.floorMs).toBe(T0 - 3 * HOUR - 120_000)
    await second.ready()
    expect(world.rows(old)).toBe(1)
  })

  test('F1 the startup write is retried until it lands', () => {
    const world = new World()
    world.failWrites = true
    const { catchup } = world.start()
    expect(catchup.startupPersisted()).toBe(false)
    world.failWrites = false
    expect(catchup.startupPersisted()).toBe(true)
    expect(world.state().windows).toHaveLength(1)
    world.failWrites = true
    expect(catchup.startupPersisted()).toBe(true)
  })

  test('F2 a retried roundtable message keeps its first admission instead of spending the budget again', () => {
    const cfg = { channelId: 'rt', replyInThread: true, autoContinue: true, budgetN: 1 }
    const input = { threadId: 't', authorIsSelf: false, authorIsBot: true, authorIsHuman: false, isExplicitMention: false, isMember: true }
    const attempt = (memo: AdmissionMemo | undefined, store: ReturnType<typeof createThreadBudgetStore>, durable: boolean) => {
      const admitted = memo?.has('m') ? true : decideTopicThreadHandling(input, store, cfg).handle
      if (!admitted) return 'dropped'
      memo?.remember('m')
      if (!durable) return 'failed'
      memo?.forget('m')
      return 'recorded'
    }
    const withoutMemo = createThreadBudgetStore()
    seedThreadBudget(withoutMemo, 't', 1)
    expect([attempt(undefined, withoutMemo, false), attempt(undefined, withoutMemo, true)]).toEqual(['failed', 'dropped'])

    const memo = new AdmissionMemo(2)
    const store = createThreadBudgetStore()
    seedThreadBudget(store, 't', 1)
    expect([attempt(memo, store, false), attempt(memo, store, true)]).toEqual(['failed', 'recorded'])
    expect(memo.has('m')).toBe(false)
    memo.remember('a')
    memo.remember('b')
    memo.remember('c')
    expect([memo.has('a'), memo.has('b'), memo.has('c')]).toEqual([false, true, true])
  })

  test('F3 caught channels leave no per-channel bookkeeping behind', async () => {
    const world = new World()
    world.writeState({ liveThroughMs: T0 })
    const threads = Array.from({ length: 20 }, () => world.addThread(T0 - HOUR))
    for (const t of threads) world.post(t, T0 + 1_000)
    world.now = T0 + MIN
    const { catchup, live, ready } = world.start()
    await ready()
    for (const t of threads) await live(world.post(t, world.now + 1_000))
    expect(catchup.memorySizes()).toEqual({ tracks: 0, caught: 0, touched: 0 })
    expect(threads.every(t => world.state().cursors[t] !== undefined)).toBe(true)
  })
})
