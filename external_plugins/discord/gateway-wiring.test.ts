import { describe, expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { attachGatewayLifecycleEvents, attachGatewayStatusEvents } from './gateway-wiring'
import { GatewayStatusTelemetry } from './gateway-status'

describe('attachGatewayLifecycleEvents', () => {
  it('records real SDK ACK events and refuses stale manager events after replacement', () => {
    const client = new EventEmitter()
    const manager = new EventEmitter()
    let current: EventEmitter = manager
    let now = 99_000
    const status = new GatewayStatusTelemetry({
      project: 'fixture', lead: 'eng-lead', identityDigest: 'a'.repeat(64),
      launchGeneration: 'launch-one', leaseGeneration: 7,
      serverPid: 200, serverStart: 'server-start', parentPid: 100, parentStart: 'parent-start',
      botUserId: '22345678901234567',
    }, () => now)
    const refresh = attachGatewayStatusEvents(client, {
      telemetry: () => status, manager: () => current,
      interval: () => 41_250, supported: () => true,
    })
    client.emit('shardReady', 0)
    now = 100_000
    refresh()
    manager.emit('heartbeat', { shardId: 0, ackAt: 100_000, heartbeatAt: 99_950, latency: 50 })
    expect(status.snapshot().telemetry).toBe('available')
    current = new EventEmitter()
    refresh()
    manager.emit('heartbeat', { shardId: 0, ackAt: 100_000, heartbeatAt: 99_950, latency: 50 })
    expect(status.snapshot().telemetry).toBe('unavailable')
    client.emit('shardResume', 0, 1)
    current.emit('heartbeat', { shardId: 0, ackAt: 100_000, heartbeatAt: 100_000, latency: 0 })
    expect(status.snapshot().telemetry).toBe('available')
    client.emit('shardDisconnect', { code: 1000 }, 0)
    expect(status.snapshot().shards[0].state).toBe('disconnected')
  })
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
