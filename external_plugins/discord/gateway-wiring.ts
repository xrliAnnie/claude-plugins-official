import type { GatewayShardClose } from './gateway-health'

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
