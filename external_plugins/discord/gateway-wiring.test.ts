import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { attachGatewayLifecycleEvents } from './gateway-wiring'

describe('attachGatewayLifecycleEvents', () => {
  it('maps every discord.js lifecycle event to the health monitor contract', () => {
    const client = new EventEmitter()
    const calls: unknown[][] = []
    attachGatewayLifecycleEvents(client, {
      onShardReconnecting: shardId => { calls.push(['reconnecting', shardId]) },
      onShardResume: (shardId, replayed) => { calls.push(['resume', shardId, replayed]) },
      onShardReady: shardId => { calls.push(['ready', shardId]) },
      onShardDisconnect: (event, shardId) => { calls.push(['disconnect', event, shardId]) },
      onShardError: (error, shardId) => { calls.push(['error', error.message, shardId]) },
      onInvalidated: () => { calls.push(['invalidated']) },
    })
    const close = { code: 4014, reason: 'Disallowed intents', wasClean: true }

    client.emit('shardReconnecting', 0)
    client.emit('shardResume', 0, 7)
    client.emit('shardReady', 0, new Set<string>())
    client.emit('shardDisconnect', close, 0)
    client.emit('shardError', new Error('socket failed'), 0)
    client.emit('invalidated')

    expect(calls).toEqual([
      ['reconnecting', 0],
      ['resume', 0, 7],
      ['ready', 0],
      ['disconnect', close, 0],
      ['error', 'socket failed', 0],
      ['invalidated'],
    ])
  })
})
