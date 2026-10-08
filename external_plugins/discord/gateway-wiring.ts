import type { GatewayShardClose } from './gateway-health'
import type { GatewayStatusTelemetry } from './gateway-status'

export interface GatewayLifecycleMonitor {
  onShardReconnecting(shardId: number): void
  onShardResume(shardId: number, replayedEvents: number): void
  onShardReady(shardId: number): void
  onShardDisconnect(event: GatewayShardClose, shardId: number): void
  onShardError(error: Error, shardId: number): void
  onInvalidated(): void
}

export interface GatewayLifecycleClient {
  on(event: 'shardReconnecting', listener: (shardId: number) => void): unknown
  on(
    event: 'shardResume',
    listener: (shardId: number, replayedEvents: number) => void,
  ): unknown
  on(
    event: 'shardReady',
    listener: (shardId: number, unavailableGuilds?: Set<string>) => void,
  ): unknown
  on(
    event: 'shardDisconnect',
    listener: (event: GatewayShardClose, shardId: number) => void,
  ): unknown
  on(
    event: 'shardError',
    listener: (error: Error, shardId: number) => void,
  ): unknown
  on(event: 'invalidated', listener: () => void): unknown
}

export function attachGatewayLifecycleEvents(
  client: GatewayLifecycleClient,
  monitor: GatewayLifecycleMonitor,
): void {
  client.on('shardReconnecting', shardId => {
    monitor.onShardReconnecting(shardId)
  })
  client.on('shardResume', (shardId, replayedEvents) => {
    monitor.onShardResume(shardId, replayedEvents)
  })
  client.on('shardReady', shardId => {
    monitor.onShardReady(shardId)
  })
  client.on('shardDisconnect', (event, shardId) => {
    monitor.onShardDisconnect(
      {
        code: event.code,
        reason: event.reason,
        wasClean: event.wasClean,
      },
      shardId,
    )
  })
  client.on('shardError', (error, shardId) => {
    monitor.onShardError(error, shardId)
  })
  client.on('invalidated', () => {
    monitor.onInvalidated()
  })
}

interface HeartbeatManager {
  on(event: string, listener: (data: unknown) => void): unknown
  off(event: string, listener: (data: unknown) => void): unknown
}

// Return a refresh function because discord.js constructs its internal manager
// during login. Replacement invalidates old ACKs and detaches the former source.
export function attachGatewayStatusEvents(client: GatewayLifecycleClient, options: {
  telemetry(): GatewayStatusTelemetry | null
  manager(): unknown
  supported(): boolean
  interval(shardId: number): number | null
}): () => void {
  let current: HeartbeatManager | null = null
  let listener: ((data: unknown) => void) | null = null
  client.on('shardReady', id => { options.telemetry()?.ready(id) })
  client.on('shardResume', id => { options.telemetry()?.ready(id) })
  client.on('shardReconnecting', id => { options.telemetry()?.reconnecting(id) })
  client.on('shardDisconnect', (_event, id) => { options.telemetry()?.disconnected(id) })
  client.on('shardError', (_error, id) => { options.telemetry()?.disconnected(id) })
  client.on('invalidated', () => { options.telemetry()?.invalidated() })
  return () => {
    const candidate = options.manager() as Partial<HeartbeatManager> | null
    if (!options.supported() || !candidate || typeof candidate.on !== 'function' || typeof candidate.off !== 'function') {
      options.telemetry()?.unavailable()
      if (current && listener) current.off('heartbeat', listener)
      current = null
      listener = null
      return
    }
    if (candidate === current) return
    if (current && listener) {
      current.off('heartbeat', listener)
      options.telemetry()?.invalidated()
    }
    current = candidate as HeartbeatManager
    const captured = current
    listener = event => {
      if (current !== captured || options.manager() !== captured || !options.supported()) return
      const id = typeof event === 'object' && event !== null ? (event as { shardId?: unknown }).shardId : null
      options.telemetry()?.heartbeat(event, typeof id === 'number' ? options.interval(id) : null)
    }
    current.on('heartbeat', listener)
  }
}
