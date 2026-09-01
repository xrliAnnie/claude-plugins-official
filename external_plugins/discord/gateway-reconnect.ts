const PINNED_DISCORD_JS_VERSION = '14.25.1'

// @discordjs/ws@1.2.3 WebSocketShardDestroyRecovery.Reconnect. Keep local so
// discord.js remains the only dependency that owns the transitive ws version.
const WS_SHARD_RECOVER_RECONNECT = 0

interface RawShard {
  destroy(options: { reason: string; recover: number }): Promise<unknown> | unknown
}

interface ShardCollection {
  size: number
  values(): IterableIterator<unknown>
}

export type RawShardReconnectInspection =
  | {
      ok: true
      forceReconnect(reason: string): Promise<void>
    }
  | {
      ok: false
      reason: string
    }

export function inspectRawShardReconnect(
  clientWs: unknown,
  discordVersion: string,
): RawShardReconnectInspection {
  if (discordVersion !== PINNED_DISCORD_JS_VERSION) {
    return {
      ok: false,
      reason:
        `unsupported discord.js version ${discordVersion}; ` +
        `expected ${PINNED_DISCORD_JS_VERSION}`,
    }
  }

  const initial = readRawShards(clientWs)
  if (initial.ok === false) return initial
  let permanentlyDisabledReason: string | undefined

  return {
    ok: true,
    async forceReconnect(reason: string): Promise<void> {
      if (permanentlyDisabledReason) {
        throw new Error(
          `raw-shard reconnect permanently disabled: ${permanentlyDisabledReason}`,
        )
      }
      const current = readRawShards(clientWs)
      if (current.ok === false) {
        permanentlyDisabledReason = current.reason
        throw new Error(current.reason)
      }
      const shards = current.shards
      await Promise.all(
        shards.map(shard =>
          Promise.resolve().then(() =>
            shard.destroy({
              reason,
              recover: WS_SHARD_RECOVER_RECONNECT,
            }),
          ),
        ),
      )
    },
  }
}

function readRawShards(
  clientWs: unknown,
): { ok: true; shards: RawShard[] } | { ok: false; reason: string } {
  const ws = asRecord(clientWs)
  const internal = asRecord(ws?._ws)
  const strategy = asRecord(internal?.strategy)
  const candidate = strategy?.shards
  if (!isShardCollection(candidate)) {
    return {
      ok: false,
      reason: 'discord.js private gateway strategy.shards collection is unavailable',
    }
  }
  if (candidate.size === 0) {
    return {
      ok: false,
      reason: 'discord.js private gateway strategy.shards collection is empty',
    }
  }

  const shards: RawShard[] = []
  for (const value of candidate.values()) {
    const shard = asRecord(value)
    if (!shard || typeof shard.destroy !== 'function') {
      return {
        ok: false,
        reason: 'discord.js private gateway strategy contains a shard without destroy()',
      }
    }
    shards.push(shard as unknown as RawShard)
  }
  if (shards.length === 0) {
    return {
      ok: false,
      reason: 'discord.js private gateway strategy yielded no shards',
    }
  }
  return { ok: true, shards }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null
    ? value as Record<string, unknown>
    : undefined
}

function isShardCollection(value: unknown): value is ShardCollection {
  const record = asRecord(value)
  return (
    !!record &&
    typeof record.size === 'number' &&
    Number.isInteger(record.size) &&
    record.size >= 0 &&
    typeof record.values === 'function'
  )
}
