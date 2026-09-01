import { describe, expect, it } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { inspectRawShardReconnect } from './gateway-reconnect'

describe('discord.js 14.25.1 raw-shard reconnect adapter', () => {
  it('reconnects the same live strategy map twice without clearing it', async () => {
    const calls: Array<{ shardId: number; reason: string; recover: number }> = []
    const shards = new Map([
      [0, {
        destroy: async (options: { reason: string; recover: number }) => {
          calls.push({ shardId: 0, ...options })
        },
      }],
      [1, {
        destroy: async (options: { reason: string; recover: number }) => {
          calls.push({ shardId: 1, ...options })
        },
      }],
    ])
    const inspected = inspectRawShardReconnect(
      { _ws: { strategy: { shards } } },
      '14.25.1',
    )

    expect(inspected.ok).toBe(true)
    if (!inspected.ok) throw new Error(inspected.reason)
    await inspected.forceReconnect('first recovery')
    expect(shards.size).toBe(2)
    await inspected.forceReconnect('second recovery')
    expect(shards.size).toBe(2)
    expect(calls).toEqual([
      { shardId: 0, reason: 'first recovery', recover: 0 },
      { shardId: 1, reason: 'first recovery', recover: 0 },
      { shardId: 0, reason: 'second recovery', recover: 0 },
      { shardId: 1, reason: 'second recovery', recover: 0 },
    ])
  })

  it('permanently disables reconnect after the private shard shape becomes invalid', async () => {
    let destroyCalls = 0
    const shard = {
      destroy: async () => { destroyCalls += 1 },
    }
    const shards = new Map([[0, shard]])
    const inspected = inspectRawShardReconnect(
      { _ws: { strategy: { shards } } },
      '14.25.1',
    )

    expect(inspected.ok).toBe(true)
    if (!inspected.ok) throw new Error(inspected.reason)
    shards.clear()
    await expect(inspected.forceReconnect('shape lost')).rejects.toThrow(/shards collection is empty/)

    shards.set(0, shard)
    await expect(inspected.forceReconnect('must remain disabled')).rejects.toThrow(/permanently disabled/)
    expect(destroyCalls).toBe(0)
  })

  it('pins the package and transitive websocket bytes that define the private seam', () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dir, 'package.json'), 'utf8'),
    ) as {
      dependencies: Record<string, string>
    }
    const lock = readFileSync(join(import.meta.dir, 'bun.lock'), 'utf8')

    expect(packageJson.dependencies['discord.js']).toBe('14.25.1')
    expect(lock).toContain('discord.js@14.25.1')
    expect(lock).toContain('@discordjs/ws@1.2.3')
  })

  it('dispatches reconnect to every shard even when one destroy throws synchronously', async () => {
    const called: number[] = []
    const shards = new Map([
      [0, {
        destroy: () => {
          called.push(0)
          throw new Error('shard zero failed synchronously')
        },
      }],
      [1, {
        destroy: async () => { called.push(1) },
      }],
    ])
    const inspected = inspectRawShardReconnect(
      { _ws: { strategy: { shards } } },
      '14.25.1',
    )

    expect(inspected.ok).toBe(true)
    if (!inspected.ok) throw new Error(inspected.reason)
    await expect(inspected.forceReconnect('parallel recovery')).rejects.toThrow(
      /shard zero failed synchronously/,
    )
    expect(called).toEqual([0, 1])
  })
})
