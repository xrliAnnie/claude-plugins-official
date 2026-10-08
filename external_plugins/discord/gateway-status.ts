// Observation only. The consumer must independently validate canonical identity,
// OS tuples, generation and deployment; this file never authorizes recovery.
export interface GatewayInstanceBinding {
  project: string
  lead: string
  identityDigest: string
  launchGeneration: string
  leaseGeneration: number
  serverPid: number
  serverStart: string
  parentPid: number
  parentStart: string
  botUserId: string
}

export interface GatewayShardStatus {
  shardId: number
  state: 'ready' | 'reconnecting' | 'disconnected'
  lastReadyAt: number | null
  lastAckAt: number | null
  heartbeatIntervalMs: number | null
}

export interface GatewayStatusSnapshot extends GatewayInstanceBinding {
  v: 1
  contract: 'lead-discord-gateway/v1'
  updatedAt: number
  telemetry: 'available' | 'unavailable'
  shards: GatewayShardStatus[]
  chatProducer?: import('./chat-producer-contract').ChatProducerContractMarker
}

const record = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? value as Record<string, unknown> : null
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
const label = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,127}$/.test(value)
const start = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\r\n\x00]/.test(value)

export class GatewayStatusTelemetry {
  private readonly binding: GatewayInstanceBinding
  private readonly shards = new Map<number, GatewayShardStatus>()
  private available = false

  constructor(binding: GatewayInstanceBinding, private readonly now = Date.now) {
    if (!label(binding.project) || !label(binding.lead) ||
      !/^[a-f0-9]{64}$/.test(binding.identityDigest) || !label(binding.launchGeneration) ||
      !integer(binding.leaseGeneration, 1, Number.MAX_SAFE_INTEGER) ||
      !integer(binding.serverPid, 2, Number.MAX_SAFE_INTEGER) ||
      !integer(binding.parentPid, 2, Number.MAX_SAFE_INTEGER) ||
      !start(binding.serverStart) || !start(binding.parentStart) ||
      !/^[0-9]{17,20}$/.test(binding.botUserId)) throw new Error('gateway_instance_binding_invalid')
    // Project only declared fields. No token, content, env or session secret.
    this.binding = {
      project: binding.project, lead: binding.lead, identityDigest: binding.identityDigest,
      launchGeneration: binding.launchGeneration, leaseGeneration: binding.leaseGeneration,
      serverPid: binding.serverPid, serverStart: binding.serverStart,
      parentPid: binding.parentPid, parentStart: binding.parentStart, botUserId: binding.botUserId,
    }
  }

  ready(shardId: number): void {
    const shard = this.shard(shardId)
    if (!shard) return
    shard.state = 'ready'
    shard.lastReadyAt = this.now()
    shard.lastAckAt = null
    shard.heartbeatIntervalMs = null
    this.available = false
  }

  reconnecting(shardId: number): void { this.clear(shardId, 'reconnecting') }
  disconnected(shardId: number): void { this.clear(shardId, 'disconnected') }
  invalidated(): void {
    for (const shardId of this.shards.keys()) this.disconnected(shardId)
    this.available = false
  }
  unavailable(): void {
    this.available = false
    for (const shard of this.shards.values()) {
      shard.lastAckAt = null
      shard.heartbeatIntervalMs = null
    }
  }

  heartbeat(event: unknown, interval: number | null): boolean {
    const data = record(event)
    const shard = data && integer(data.shardId, 0, 65535) ? this.shard(data.shardId) : null
    if (!data || !shard || !integer(data.ackAt, 1, this.now()) ||
      !integer(data?.heartbeatAt, 1, data.ackAt) ||
      typeof data.latency !== 'number' || !Number.isFinite(data.latency) || data.latency < 0 ||
      !integer(interval, 1000, 300_000)) {
      this.unavailable()
      return false
    }
    // An ACK from the previous connection, or a reordered older ACK, cannot
    // refresh this shard. READY/RESUMED invalidates its former ACK first.
    if (shard.state !== 'ready' || shard.lastReadyAt === null ||
      data.heartbeatAt < shard.lastReadyAt || (shard.lastAckAt !== null && data.ackAt <= shard.lastAckAt)) return false
    shard.lastAckAt = data.ackAt
    shard.heartbeatIntervalMs = interval
    this.available = true
    return true
  }

  snapshot(): GatewayStatusSnapshot {
    return {
      v: 1, contract: 'lead-discord-gateway/v1', ...this.binding, updatedAt: this.now(),
      telemetry: this.available ? 'available' : 'unavailable',
      shards: [...this.shards.values()].map(shard => ({ ...shard })).sort((a, b) => a.shardId - b.shardId),
    }
  }

  private shard(shardId: number): GatewayShardStatus | null {
    if (!integer(shardId, 0, 65535)) { this.unavailable(); return null }
    let shard = this.shards.get(shardId)
    if (!shard) {
      if (this.shards.size >= 64) { this.unavailable(); return null }
      shard = { shardId, state: 'disconnected', lastReadyAt: null, lastAckAt: null, heartbeatIntervalMs: null }
      this.shards.set(shardId, shard)
    }
    return shard
  }
  private clear(shardId: number, state: GatewayShardStatus['state']): void {
    const shard = this.shard(shardId)
    if (shard) {
      shard.state = state
      shard.lastReadyAt = null
      shard.lastAckAt = null
      shard.heartbeatIntervalMs = null
    }
    this.available = false
  }
}

// The pinned SDK assigns HELLO's heartbeat_interval to its real timer's _repeat.
// No guessed/default interval is accepted when this compatibility seam drifts.
export function inspectHeartbeatInterval(
  clientWs: unknown, shardId: number, discordVersion: string, wsVersion: string,
): number | null {
  if (discordVersion !== '14.25.1' || wsVersion !== '1.2.3') return null
  const shards = record(record(record(clientWs)?._ws)?.strategy)?.shards
  if (!(shards instanceof Map) || shards.size < 1 || shards.size > 64) return null
  const shard = record(shards.get(shardId))
  const interval = record(shard?.heartbeatInterval)?._repeat
  return shard?.id === shardId && integer(interval, 1000, 300_000) ? interval : null
}
