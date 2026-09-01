import { describe, expect, it } from 'bun:test'
import {
  GatewayHealthMonitor,
  type GatewayHealthScheduler,
} from './gateway-health'

class TestScheduler implements GatewayHealthScheduler {
  nowMs = 0
  private nextId = 1
  private readonly timers = new Map<number, { at: number; run: () => void }>()

  setTimeout(run: () => void, delayMs: number): number {
    const id = this.nextId++
    this.timers.set(id, { at: this.nowMs + delayMs, run })
    return id
  }

  clearTimeout(id: unknown): void {
    this.timers.delete(id as number)
  }

  pendingCount(): number {
    return this.timers.size
  }

  async advanceBy(ms: number): Promise<void> {
    const target = this.nowMs + ms
    while (true) {
      const due = [...this.timers.entries()]
        .filter(([, timer]) => timer.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!due) break
      this.nowMs = due[1].at
      this.timers.delete(due[0])
      due[1].run()
      await Promise.resolve()
    }
    this.nowMs = target
    await Promise.resolve()
  }
}

describe('GatewayHealthMonitor lifecycle recovery', () => {
  it('does not force reconnect or alert when a reconnect resumes before its deadline', async () => {
    const scheduler = new TestScheduler()
    const reconnects: string[] = []
    const alerts: string[] = []
    const monitor = new GatewayHealthMonitor({
      gatewayWatchEnabled: true,
      echoProbeEnabled: false,
      echoTimeoutMs: 60_000,
      recoveryDeadlineMs: 90_000,
      pendingCap: 200,
      earlyEchoCap: 1_000,
      scheduler,
      forceReconnect: async reason => { reconnects.push(reason) },
      alertFailure: async failure => { alerts.push(failure.body) },
      log: () => {},
    })

    monitor.onShardReconnecting(0)
    expect(scheduler.pendingCount()).toBe(1)
    await scheduler.advanceBy(89_999)
    monitor.onShardResume(0, 4)
    expect(scheduler.pendingCount()).toBe(0)
    await scheduler.advanceBy(10)

    expect(reconnects).toEqual([])
    expect(alerts).toEqual([])
  })

  it('keeps the first reconnect deadline and performs one forced recovery before alerting', async () => {
    const scheduler = new TestScheduler()
    const reconnects: string[] = []
    const alerts: string[] = []
    const monitor = new GatewayHealthMonitor({
      gatewayWatchEnabled: true,
      echoProbeEnabled: false,
      echoTimeoutMs: 60_000,
      recoveryDeadlineMs: 90_000,
      pendingCap: 200,
      earlyEchoCap: 1_000,
      scheduler,
      forceReconnect: async reason => { reconnects.push(reason) },
      alertFailure: async failure => { alerts.push(failure.body) },
      log: () => {},
    })

    monitor.onShardReconnecting(0)
    await scheduler.advanceBy(30_000)
    monitor.onShardReconnecting(0)
    expect(scheduler.pendingCount()).toBe(1)

    await scheduler.advanceBy(59_999)
    expect(reconnects).toEqual([])
    await scheduler.advanceBy(1)
    expect(reconnects).toHaveLength(1)
    expect(scheduler.pendingCount()).toBe(1)

    monitor.onShardReconnecting(0)
    await scheduler.advanceBy(90_000)
    expect(reconnects).toHaveLength(1)
    expect(alerts).toHaveLength(1)
    expect(scheduler.pendingCount()).toBe(0)
  })

  it('drops echo timers from the old connection when shard reconnecting starts', async () => {
    const scheduler = new TestScheduler()
    const reconnects: string[] = []
    const monitor = new GatewayHealthMonitor({
      gatewayWatchEnabled: true,
      echoProbeEnabled: true,
      echoTimeoutMs: 60_000,
      recoveryDeadlineMs: 90_000,
      pendingCap: 200,
      earlyEchoCap: 1_000,
      scheduler,
      forceReconnect: async reason => { reconnects.push(reason) },
      alertFailure: async () => {},
      log: () => {},
    })

    await monitor.trackedSend('100000000000000001', async () => ({
      id: '100000000000000002',
    }))
    expect(scheduler.pendingCount()).toBe(1)
    monitor.onShardReconnecting(0)

    expect(scheduler.pendingCount()).toBe(1)
    await scheduler.advanceBy(60_000)
    expect(reconnects).toEqual([])
  })

  it('alerts an unrecoverable shard disconnect immediately without forcing reconnect', async () => {
    const scheduler = new TestScheduler()
    const reconnects: string[] = []
    const alerts: string[] = []
    const monitor = new GatewayHealthMonitor({
      gatewayWatchEnabled: true,
      echoProbeEnabled: true,
      echoTimeoutMs: 60_000,
      recoveryDeadlineMs: 90_000,
      pendingCap: 200,
      earlyEchoCap: 1_000,
      scheduler,
      forceReconnect: async reason => { reconnects.push(reason) },
      alertFailure: async failure => { alerts.push(failure.body) },
      log: () => {},
    })

    monitor.onShardDisconnect(
      { code: 4014, reason: 'Disallowed intents', wasClean: true },
      0,
    )
    monitor.onShardDisconnect(
      { code: 4014, reason: 'Disallowed intents', wasClean: true },
      0,
    )
    await Promise.resolve()

    expect(reconnects).toEqual([])
    expect(alerts).toHaveLength(1)
    expect(alerts[0]).toContain('code=4014')
    expect(scheduler.pendingCount()).toBe(0)
  })

  it('records shard errors and invalidation without treating them as recovery triggers', async () => {
    const scheduler = new TestScheduler()
    const reconnects: string[] = []
    const alerts: string[] = []
    const logs: string[] = []
    const monitor = new GatewayHealthMonitor({
      gatewayWatchEnabled: true,
      echoProbeEnabled: true,
      echoTimeoutMs: 60_000,
      recoveryDeadlineMs: 90_000,
      pendingCap: 200,
      earlyEchoCap: 1_000,
      scheduler,
      forceReconnect: async reason => { reconnects.push(reason) },
      alertFailure: async failure => { alerts.push(failure.body) },
      log: message => { logs.push(message) },
    })

    monitor.onShardError(new Error('socket read failed'), 0)
    monitor.onInvalidated()
    await Promise.resolve()

    expect(logs.join('\n')).toContain('socket read failed')
    expect(logs.join('\n')).toContain('invalidated')
    expect(reconnects).toEqual([])
    expect(alerts).toEqual([])
    expect(scheduler.pendingCount()).toBe(0)
  })
})

describe('GatewayHealthMonitor self-echo probe', () => {
  it('starts a timeout only after a real send succeeds and cancels it on the matching echo', async () => {
    const scheduler = new TestScheduler()
    const reconnects: string[] = []
    const monitor = new GatewayHealthMonitor({
      gatewayWatchEnabled: false,
      echoProbeEnabled: true,
      echoTimeoutMs: 60_000,
      recoveryDeadlineMs: 90_000,
      pendingCap: 200,
      earlyEchoCap: 1_000,
      scheduler,
      forceReconnect: async reason => { reconnects.push(reason) },
      alertFailure: async () => {},
      log: () => {},
    })

    expect(scheduler.pendingCount()).toBe(0)
    const sent = await monitor.trackedSend('100000000000000001', async () => ({
      id: '100000000000000002',
    }))
    expect(sent.id).toBe('100000000000000002')
    expect(scheduler.pendingCount()).toBe(1)

    monitor.onSelfEcho('100000000000000002', '100000000000000001')
    expect(scheduler.pendingCount()).toBe(0)
    await scheduler.advanceBy(60_001)
    expect(reconnects).toEqual([])
  })

  it('cancels an echo that arrives before the REST response registers its message id', async () => {
    const scheduler = new TestScheduler()
    const reconnects: string[] = []
    let resolveSend!: (message: { id: string }) => void
    const response = new Promise<{ id: string }>(resolve => { resolveSend = resolve })
    const monitor = new GatewayHealthMonitor({
      gatewayWatchEnabled: false,
      echoProbeEnabled: true,
      echoTimeoutMs: 60_000,
      recoveryDeadlineMs: 90_000,
      pendingCap: 200,
      earlyEchoCap: 1_000,
      scheduler,
      forceReconnect: async reason => { reconnects.push(reason) },
      alertFailure: async () => {},
      log: () => {},
    })

    const sending = monitor.trackedSend('100000000000000001', () => response)
    monitor.onSelfEcho('100000000000000002', '100000000000000001')
    resolveSend({ id: '100000000000000002' })
    await sending

    expect(scheduler.pendingCount()).toBe(0)
    await scheduler.advanceBy(60_001)
    expect(reconnects).toEqual([])
  })

  it('resolves the channel from a DM send response without losing an early echo', async () => {
    const scheduler = new TestScheduler()
    let resolveSend!: (message: { id: string; channelId: string }) => void
    const response = new Promise<{ id: string; channelId: string }>(resolve => {
      resolveSend = resolve
    })
    const monitor = new GatewayHealthMonitor({
      gatewayWatchEnabled: false,
      echoProbeEnabled: true,
      echoTimeoutMs: 60_000,
      recoveryDeadlineMs: 90_000,
      pendingCap: 200,
      earlyEchoCap: 1_000,
      scheduler,
      forceReconnect: async () => {},
      alertFailure: async () => {},
      log: () => {},
    })

    const sending = monitor.trackedSend(undefined, () => response)
    monitor.onSelfEcho('100000000000000002', '100000000000000001')
    resolveSend({
      id: '100000000000000002',
      channelId: '100000000000000001',
    })
    await sending

    expect(scheduler.pendingCount()).toBe(0)
  })

  it('clears all pending echoes and runs one recovery when inbound dispatch stops', async () => {
    const scheduler = new TestScheduler()
    const reconnects: string[] = []
    const alerts: string[] = []
    const monitor = new GatewayHealthMonitor({
      gatewayWatchEnabled: false,
      echoProbeEnabled: true,
      echoTimeoutMs: 60_000,
      recoveryDeadlineMs: 90_000,
      pendingCap: 200,
      earlyEchoCap: 1_000,
      scheduler,
      forceReconnect: async reason => { reconnects.push(reason) },
      alertFailure: async failure => { alerts.push(failure.body) },
      log: () => {},
    })

    await monitor.trackedSend('100000000000000001', async () => ({ id: '100000000000000002' }))
    await monitor.trackedSend('100000000000000001', async () => ({ id: '100000000000000003' }))
    expect(scheduler.pendingCount()).toBe(2)

    await scheduler.advanceBy(59_999)
    expect(reconnects).toEqual([])
    await scheduler.advanceBy(1)
    expect(reconnects).toHaveLength(1)
    expect(scheduler.pendingCount()).toBe(1)

    monitor.onSelfEcho('100000000000000003', '100000000000000001')
    await scheduler.advanceBy(90_000)
    expect(reconnects).toHaveLength(1)
    expect(alerts).toHaveLength(1)
    expect(scheduler.pendingCount()).toBe(0)
  })

  it('bounds pending echo timers by evicting the oldest tracked message', async () => {
    const scheduler = new TestScheduler()
    const reconnects: string[] = []
    const monitor = new GatewayHealthMonitor({
      gatewayWatchEnabled: false,
      echoProbeEnabled: true,
      echoTimeoutMs: 60_000,
      recoveryDeadlineMs: 90_000,
      pendingCap: 2,
      earlyEchoCap: 1_000,
      scheduler,
      forceReconnect: async reason => { reconnects.push(reason) },
      alertFailure: async () => {},
      log: () => {},
    })

    for (const id of ['100000000000000002', '100000000000000003', '100000000000000004']) {
      await monitor.trackedSend('100000000000000001', async () => ({ id }))
    }
    expect(scheduler.pendingCount()).toBe(2)

    monitor.onSelfEcho('100000000000000003', '100000000000000001')
    monitor.onSelfEcho('100000000000000004', '100000000000000001')
    expect(scheduler.pendingCount()).toBe(0)
    await scheduler.advanceBy(60_001)
    expect(reconnects).toEqual([])
  })

  it('never starts a timer or recovery while the plugin has no outbound send', async () => {
    const scheduler = new TestScheduler()
    const reconnects: string[] = []
    const alerts: string[] = []
    const monitor = new GatewayHealthMonitor({
      gatewayWatchEnabled: false,
      echoProbeEnabled: true,
      echoTimeoutMs: 60_000,
      recoveryDeadlineMs: 90_000,
      pendingCap: 200,
      earlyEchoCap: 1_000,
      scheduler,
      forceReconnect: async reason => { reconnects.push(reason) },
      alertFailure: async failure => { alerts.push(failure.body) },
      log: () => {},
    })

    await scheduler.advanceBy(24 * 60 * 60 * 1_000)

    expect(scheduler.pendingCount()).toBe(0)
    expect(reconnects).toEqual([])
    expect(alerts).toEqual([])
  })

  it('keeps a target early echo through unrelated traffic while pruning by TTL and cap', async () => {
    const scheduler = new TestScheduler()
    const reconnects: string[] = []
    let resolveSend!: (message: { id: string }) => void
    const response = new Promise<{ id: string }>(resolve => { resolveSend = resolve })
    const monitor = new GatewayHealthMonitor({
      gatewayWatchEnabled: false,
      echoProbeEnabled: true,
      echoTimeoutMs: 60_000,
      recoveryDeadlineMs: 90_000,
      pendingCap: 200,
      earlyEchoCap: 2,
      scheduler,
      forceReconnect: async reason => { reconnects.push(reason) },
      alertFailure: async () => {},
      log: () => {},
    })

    const sending = monitor.trackedSend('100000000000000001', () => response)
    monitor.onSelfEcho('100000000000000010', '100000000000000001')
    await scheduler.advanceBy(119_999)
    monitor.onSelfEcho('100000000000000002', '100000000000000001')
    monitor.onSelfEcho('100000000000000011', '100000000000000001')
    resolveSend({ id: '100000000000000002' })
    await sending

    expect(scheduler.pendingCount()).toBe(0)
    await scheduler.advanceBy(60_001)
    expect(reconnects).toEqual([])
  })

  it('expires an early echo after twice the timeout instead of accepting stale evidence', async () => {
    const scheduler = new TestScheduler()
    const reconnects: string[] = []
    let resolveSend!: (message: { id: string }) => void
    const response = new Promise<{ id: string }>(resolve => { resolveSend = resolve })
    const monitor = new GatewayHealthMonitor({
      gatewayWatchEnabled: false,
      echoProbeEnabled: true,
      echoTimeoutMs: 60_000,
      recoveryDeadlineMs: 90_000,
      pendingCap: 200,
      earlyEchoCap: 1_000,
      scheduler,
      forceReconnect: async reason => { reconnects.push(reason) },
      alertFailure: async () => {},
      log: () => {},
    })

    const sending = monitor.trackedSend('100000000000000001', () => response)
    monitor.onSelfEcho('100000000000000002', '100000000000000001')
    await scheduler.advanceBy(120_001)
    resolveSend({ id: '100000000000000002' })
    await sending
    expect(scheduler.pendingCount()).toBe(1)

    await scheduler.advanceBy(60_000)
    expect(reconnects).toHaveLength(1)
  })

  it('starts a new one-shot recovery after a real ready edge ends the prior episode', async () => {
    const scheduler = new TestScheduler()
    const reconnects: string[] = []
    const monitor = new GatewayHealthMonitor({
      gatewayWatchEnabled: false,
      echoProbeEnabled: true,
      echoTimeoutMs: 60_000,
      recoveryDeadlineMs: 90_000,
      pendingCap: 200,
      earlyEchoCap: 1_000,
      scheduler,
      forceReconnect: async reason => { reconnects.push(reason) },
      alertFailure: async () => {},
      log: () => {},
    })

    await monitor.trackedSend('100000000000000001', async () => ({
      id: '100000000000000002',
    }))
    await scheduler.advanceBy(60_000)
    monitor.onShardReady(0)
    await monitor.trackedSend('100000000000000001', async () => ({
      id: '100000000000000003',
    }))
    await scheduler.advanceBy(60_000)

    expect(reconnects).toHaveLength(2)
  })

  it('alerts immediately when the fire-and-forget reconnect rejects', async () => {
    const scheduler = new TestScheduler()
    const alerts: string[] = []
    const monitor = new GatewayHealthMonitor({
      gatewayWatchEnabled: false,
      echoProbeEnabled: true,
      echoTimeoutMs: 60_000,
      recoveryDeadlineMs: 90_000,
      pendingCap: 200,
      earlyEchoCap: 1_000,
      scheduler,
      forceReconnect: async () => { throw new Error('raw shape changed') },
      alertFailure: async failure => { alerts.push(failure.body) },
      log: () => {},
    })

    await monitor.trackedSend('100000000000000001', async () => ({
      id: '100000000000000002',
    }))
    await scheduler.advanceBy(60_000)
    await Promise.resolve()
    await Promise.resolve()

    expect(alerts).toEqual([
      'Discord gateway forced reconnect failed: raw shape changed',
    ])
    expect(scheduler.pendingCount()).toBe(0)
  })
})
