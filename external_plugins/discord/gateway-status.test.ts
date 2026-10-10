import { describe, expect, it } from 'bun:test'
import { GatewayStatusTelemetry, inspectHeartbeatInterval } from './gateway-status'

const binding = {
  project: 'fixture', lead: 'eng-lead', identityDigest: 'a'.repeat(64),
  launchGeneration: 'launch-one', leaseGeneration: 7,
  serverPid: 200, serverStart: 'server-start', parentPid: 100, parentStart: 'parent-start',
  botUserId: '22345678901234567',
}

describe('FLY-3433 current gateway telemetry', () => {
  it('requires current READY plus real fresh ACK and never substitutes an old READY', () => {
    let now = 100_000
    const status = new GatewayStatusTelemetry(binding, () => now)
    status.ready(0)
    expect(status.snapshot().shards[0].lastAckAt).toBeNull()
    now += 1_000
    status.heartbeat({ shardId: 0, ackAt: now, heartbeatAt: now - 50, latency: 50 }, 41_250)
    expect(status.snapshot().shards[0]).toMatchObject({ state: 'ready', lastReadyAt: 100_000, lastAckAt: 101_000, heartbeatIntervalMs: 41_250 })
    status.reconnecting(0)
    expect(status.snapshot().shards[0]).toMatchObject({ state: 'reconnecting', lastAckAt: null, lastReadyAt: null })
    status.ready(0)
    expect(status.snapshot().shards[0].lastAckAt).toBeNull()
    status.disconnected(0)
    expect(status.snapshot().shards[0].state).toBe('disconnected')
  })

  it('rejects future, invalid, unordered or unsupported ACK metadata without granting telemetry', () => {
    let now = 90_000
    const status = new GatewayStatusTelemetry(binding, () => now)
    status.ready(0)
    now = 100_000
    expect(status.heartbeat({ shardId: 0, ackAt: 100_001, heartbeatAt: 90_000, latency: 1 }, 41_250)).toBe(false)
    expect(status.heartbeat({ shardId: 0, ackAt: 99_000, heartbeatAt: 99_001, latency: 1 }, 41_250)).toBe(false)
    expect(status.heartbeat({ shardId: 0, ackAt: 99_000, heartbeatAt: 98_999, latency: 1 }, null)).toBe(false)
    expect(status.snapshot().telemetry).toBe('unavailable')
    expect(status.snapshot().shards[0].lastAckAt).toBeNull()
    expect(status.heartbeat({ shardId: 0, ackAt: 100_000, heartbeatAt: 99_950, latency: 50 }, 41_250)).toBe(true)
    expect(status.snapshot().telemetry).toBe('available')
    expect(status.heartbeat({ shardId: 0, ackAt: 99_999, heartbeatAt: 99_900, latency: 99 }, 41_250)).toBe(false)
  })

  it('binds metadata to one instance and projects no tokens or message bodies', () => {
    let now = 90_000
    const status = new GatewayStatusTelemetry(binding, () => now)
    status.ready(0)
    now = 100_000
    status.heartbeat({ shardId: 0, ackAt: 100_000, heartbeatAt: 99_950, latency: 50, token: 'secret', content: 'body' }, 41_250)
    const row = status.snapshot()
    expect(row).toMatchObject({ v: 1, contract: 'lead-discord-gateway/v1', ...binding, updatedAt: 100_000 })
    expect(JSON.stringify(row)).not.toContain('secret')
    expect(JSON.stringify(row)).not.toContain('body')
    expect(() => new GatewayStatusTelemetry({ ...binding, leaseGeneration: 0 })).toThrow()
    const restarted = new GatewayStatusTelemetry({ ...binding, launchGeneration: 'launch-two', serverPid: 201 }, () => 100_100)
    expect(restarted.snapshot().shards).toEqual([])
  })

  it('refuses a delayed ACK whose heartbeat belongs to the previous READY epoch', () => {
    let now = 100_000
    const status = new GatewayStatusTelemetry(binding, () => now)
    status.ready(0)
    now = 101_000
    status.reconnecting(0)
    status.ready(0)
    now = 102_000
    expect(status.heartbeat({ shardId: 0, ackAt: now, heartbeatAt: 100_500, latency: 1500 }, 41_250)).toBe(false)
    expect(status.snapshot().shards[0].lastAckAt).toBeNull()
    expect(status.heartbeat({ shardId: 0, ackAt: now, heartbeatAt: 101_500, latency: 500 }, 41_250)).toBe(true)
  })

  it('reads only the pinned SDK HELLO timer seam and refuses unknown shapes or versions', () => {
    const ws = { _ws: { strategy: { shards: new Map([[0, { id: 0, heartbeatInterval: { _repeat: 41_250 } }]]) } } }
    expect(inspectHeartbeatInterval(ws, 0, '14.25.1', '1.2.3')).toBe(41_250)
    expect(inspectHeartbeatInterval(ws, 0, '14.26.0', '1.2.3')).toBeNull()
    expect(inspectHeartbeatInterval(ws, 0, '14.25.1', '1.2.4')).toBeNull()
    expect(inspectHeartbeatInterval(ws, 1, '14.25.1', '1.2.3')).toBeNull()
    expect(inspectHeartbeatInterval({ _ws: { strategy: { shards: new Map([[0, { id: 0, heartbeatInterval: { _repeat: -1 } }]]) } } }, 0, '14.25.1', '1.2.3')).toBeNull()
  })
})
