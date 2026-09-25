import { expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { SelfAuthorFilter, attachSelfAuthorFilter } from './self-author-filter'

const bot = '100000000000000005'
const founder = '100000000000000006'

function fixture(
  guard?: (id: string | undefined, ready: boolean, author: string) => boolean,
) {
  const client = new EventEmitter() as EventEmitter & {
    user?: { id: string }
    isReady(): boolean
  }
  let clientReady = true
  client.isReady = () => clientReady
  const invalid: string[] = []
  const filter = new SelfAuthorFilter(guard, id => { invalid.push(id) })
  const received: string[] = []
  const echoes: string[] = []
  const logs: string[] = []
  attachSelfAuthorFilter(client, filter, {
    onOther: msg => { received.push(msg.author.id) },
    onSelfEcho: msg => { echoes.push(msg.author.id) },
    log: line => { logs.push(line) },
  })
  let message = 0
  const emit = (author: string) => {
    message += 1
    client.emit('messageCreate', {
      id: `2000000000000000${message}`,
      channelId: '300000000000000001',
      author: { id: author, bot: author === bot },
    })
  }
  return {
    client,
    filter,
    received,
    echoes,
    invalid,
    logs,
    emit,
    setClientReady(value: boolean) { clientReady = value },
  }
}

it('drops self before any access/delivery callback while normal founder proceeds', () => {
  const f = fixture()
  f.client.user = { id: bot }
  f.client.emit('ready', f.client)
  f.emit(bot)
  f.emit(founder)

  expect(f.received).toEqual([founder])
  expect(f.echoes).toEqual([bot])
  expect(f.filter.observe({
    recorderEnabled: true,
    currentUserId: bot,
    clientReady: true,
  })).toMatchObject({
    botUserId: bot,
    ready: true,
    selfDropped: true,
    unknownDropped: true,
    otherPassed: true,
  })
})

it('admits replayed founder messages during reconnect and records their ordering', () => {
  const f = fixture()
  f.client.user = { id: bot }
  f.client.emit('ready', f.client)
  f.client.emit('shardReconnecting', 0)
  f.emit(founder)
  f.emit(bot)
  f.client.emit('shardResume', 0, 7)
  f.emit(founder)

  expect(f.received).toEqual([founder, founder])
  expect(f.echoes).toEqual([bot])
  const reconnect = f.logs.findIndex(line => line.includes('event=reconnecting'))
  const admitted = f.logs.findIndex(line => line.includes('admitted-while-reconnecting'))
  const resumed = f.logs.findIndex(line => line.includes('event=resume replayed=7'))
  expect(reconnect).toBeGreaterThanOrEqual(0)
  expect(admitted).toBeGreaterThan(reconnect)
  expect(resumed).toBeGreaterThan(admitted)
  expect(f.logs.filter(line => line.includes('admitted-while-reconnecting'))).toHaveLength(1)
})

it('keeps pinned-identity intake alive when disconnected and client.user is absent', () => {
  const f = fixture()
  f.client.user = { id: bot }
  f.client.emit('ready', f.client)
  f.client.emit('shardDisconnect', { code: 1006 }, 0)
  f.setClientReady(false)
  f.client.user = undefined
  f.emit(founder)
  f.emit(bot)

  expect(f.received).toEqual([founder])
  expect(f.echoes).toEqual([bot])
  expect(f.filter.observe({
    recorderEnabled: true,
    currentUserId: undefined,
    clientReady: false,
  }).ready).toBe(false)
})

it('rearms probe readiness after invalidation and a fresh shard identify', () => {
  const f = fixture()
  f.client.user = { id: bot }
  f.client.emit('ready', f.client)
  f.client.emit('invalidated')
  f.emit(founder)
  f.client.emit('shardReady', 0, new Set<string>())

  expect(f.received).toEqual([founder])
  expect(f.filter.observe({
    recorderEnabled: true,
    currentUserId: bot,
    clientReady: true,
  }).ready).toBe(true)
})

it('keeps self out even when downstream allowBots contains the owning bot', () => {
  const client = new EventEmitter() as EventEmitter & {
    user?: { id: string }
    isReady(): boolean
  }
  client.isReady = () => true
  client.user = { id: bot }
  const handled: string[] = []
  attachSelfAuthorFilter(client, new SelfAuthorFilter(), {
    onSelfEcho: () => {},
    onOther: msg => {
      if (!msg.author.bot || [bot].includes(msg.author.id)) handled.push(msg.author.id)
    },
    log: () => {},
  })
  client.emit('ready', client)
  for (const event of ['shardReconnecting', 'shardDisconnect', 'invalidated']) {
    client.emit(event, 0)
    client.emit('messageCreate', {
      id: '200000000000000001',
      channelId: '300000000000000001',
      author: { id: bot, bot: true },
    })
  }

  expect(handled).toEqual([])
})

it('does not poison identity when a pre-ready probe sees client.user', () => {
  const f = fixture()
  f.client.user = { id: bot }

  expect(f.filter.observe({
    recorderEnabled: true,
    currentUserId: bot,
    clientReady: false,
  }).ready).toBe(false)
  expect(f.invalid).toEqual([])

  f.client.emit('ready', f.client)
  f.emit(founder)
  f.emit(bot)
  expect(f.received).toEqual([founder])
  expect(f.echoes).toEqual([bot])
  expect(f.filter.observe({
    recorderEnabled: true,
    currentUserId: bot,
    clientReady: true,
  }).ready).toBe(true)
})

it('fails closed permanently after a pinned identity changes and reports once', () => {
  const f = fixture()
  f.client.user = { id: bot }
  f.client.emit('ready', f.client)
  f.client.user = { id: '100000000000000099' }
  f.emit(founder)
  f.client.emit('ready', f.client)
  f.emit(founder)

  expect(f.received).toEqual([])
  expect(f.invalid).toEqual(['100000000000000099'])
  expect(f.filter.observe({
    recorderEnabled: true,
    currentUserId: '100000000000000099',
    clientReady: true,
  }).ready).toBe(false)
})

it('keeps voice unavailable outside enabled recorder mode without bypassing self guard', () => {
  const f = fixture()
  f.client.user = { id: bot }
  f.client.emit('ready', f.client)

  expect(f.filter.observe({
    recorderEnabled: false,
    currentUserId: bot,
    clientReady: true,
  }).ready).toBe(false)
  f.emit(bot)
  expect(f.received).toEqual([])
})

it('probe detects mutation of the same guard used by the registered callback', () => {
  const f = fixture(() => true)
  f.client.user = { id: bot }
  f.client.emit('ready', f.client)
  f.emit(bot)

  expect(f.received).toEqual([bot])
  expect(f.filter.observe({
    recorderEnabled: true,
    currentUserId: bot,
    clientReady: true,
  })).toMatchObject({ selfDropped: false, unknownDropped: false })
})

it('bounds reconnect admission diagnostics and reports suppression on recovery', () => {
  const f = fixture()
  f.client.user = { id: bot }
  f.client.emit('ready', f.client)
  f.client.emit('shardReconnecting', 0)
  for (let index = 0; index < 52; index += 1) f.emit(founder)
  f.client.emit('shardResume', 0, 52)

  expect(f.received).toHaveLength(52)
  expect(f.logs.filter(line => line.includes('admitted-while-reconnecting'))).toHaveLength(50)
  expect(f.logs.find(line => line.includes('event=resume replayed=52'))).toContain('suppressed=2')
})
