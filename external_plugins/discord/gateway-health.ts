export interface GatewayHealthScheduler {
  setTimeout(run: () => void, delayMs: number): unknown
  clearTimeout(timer: unknown): void
  nowMs?: number
}

export interface GatewayHealthFailure {
  episodeKey: string
  body: string
}

export interface GatewayHealthMonitorOptions {
  gatewayWatchEnabled: boolean
  echoProbeEnabled: boolean
  echoTimeoutMs: number
  recoveryDeadlineMs: number
  pendingCap: number
  earlyEchoCap: number
  scheduler: GatewayHealthScheduler
  forceReconnect(reason: string): Promise<void>
  alertFailure(failure: GatewayHealthFailure): Promise<void>
  log(message: string): void
}

interface TrackedMessage {
  id: string
  channelId?: string
}

const FORCED_RECONNECT_BUDGET = 3
const FORCED_RECONNECT_WINDOW_MS = 60 * 60 * 1_000

export interface GatewayShardClose {
  code: number
  reason: string
  wasClean: boolean
}

export class GatewayHealthMonitor {
  private reconnectDeadline: unknown
  private budgetLatchDeadline: unknown
  private readonly forcedReconnectAttempts: number[] = []
  private trackedRestInFlight = 0
  private readonly pendingEchoes = new Map<
    string,
    { channelId: string; timer: unknown }
  >()
  private readonly earlySelfEchoes = new Map<
    string,
    { channelId: string; seenAt: number }
  >()
  private episode:
    | {
        key: string
        forced: boolean
        alerted: boolean
        budgetLatched?: boolean
      }
    | undefined
  private episodeSequence = 0

  constructor(private readonly options: GatewayHealthMonitorOptions) {}

  onShardReconnecting(shardId: number): void {
    this.log(`gateway shard ${shardId} reconnecting`)
    // Echoes from the old socket can never arrive after this edge. Keeping
    // their timers would race the library's legitimate Resume path and trigger
    // a redundant forced reconnect before the lifecycle deadline.
    this.clearPendingEchoes()
    if (!this.options.gatewayWatchEnabled || this.episode) return
    this.episode = {
      key: `gateway-recovery-${++this.episodeSequence}`,
      forced: false,
      alerted: false,
    }
    this.reconnectDeadline = this.options.scheduler.setTimeout(() => {
      this.reconnectDeadline = undefined
      this.log(`gateway shard ${shardId} reconnect deadline elapsed`)
      this.beginForcedRecovery('Discord gateway did not resume before its recovery deadline')
    }, this.options.recoveryDeadlineMs)
  }

  onShardResume(shardId: number, replayedEvents: number): void {
    this.log(`gateway shard ${shardId} resumed; replayed=${replayedEvents}`)
    this.finishRecovery()
  }

  onShardReady(shardId: number): void {
    this.log(`gateway shard ${shardId} ready`)
    this.finishRecovery()
  }

  onShardDisconnect(event: GatewayShardClose, shardId: number): void {
    this.log(
      `gateway shard ${shardId} disconnected permanently; ` +
      `code=${event.code} reason=${event.reason} wasClean=${event.wasClean}`,
    )
    if (!this.episode) {
      this.episode = {
        key: `gateway-recovery-${++this.episodeSequence}`,
        forced: false,
        alerted: false,
      }
    }
    this.clearReconnectDeadline()
    this.clearPendingEchoes()
    this.failEpisode(
      `Discord gateway shard ${shardId} disconnected with unrecoverable ` +
      `code=${event.code}; reason=${event.reason}; wasClean=${event.wasClean}`,
    )
  }

  onShardError(error: Error, shardId: number): void {
    this.log(`gateway shard ${shardId} error: ${formatError(error)}`)
  }

  onInvalidated(): void {
    this.log(
      'gateway invalidated event observed (future-compatible; not recovery evidence)',
    )
  }

  async trackedSend<T extends TrackedMessage>(
    channelId: string | undefined,
    send: () => Promise<T>,
  ): Promise<T> {
    this.trackedRestInFlight += 1
    try {
      const sent = await send()
      if (this.options.echoProbeEnabled && !this.episode) {
        const resolvedChannelId = channelId ?? sent.channelId
        if (!resolvedChannelId) {
          this.log(
            `gateway self echo probe skipped message ${sent.id}: channel id unavailable`,
          )
          return sent
        }
        this.pruneEarlySelfEchoes()
        const early = this.earlySelfEchoes.get(sent.id)
        if (early?.channelId === resolvedChannelId) {
          this.earlySelfEchoes.delete(sent.id)
          this.log(`gateway early self echo confirmed message ${sent.id}`)
        } else {
          this.registerPendingEcho(sent.id, resolvedChannelId)
        }
      }
      return sent
    } finally {
      this.trackedRestInFlight -= 1
    }
  }

  onSelfEcho(messageId: string, channelId: string): void {
    const pending = this.pendingEchoes.get(messageId)
    if (pending?.channelId === channelId) {
      this.options.scheduler.clearTimeout(pending.timer)
      this.pendingEchoes.delete(messageId)
      this.log(`gateway self echo confirmed message ${messageId}`)
      return
    }
    if (
      !this.options.echoProbeEnabled ||
      this.episode ||
      this.trackedRestInFlight === 0
    ) return
    this.pruneEarlySelfEchoes()
    this.earlySelfEchoes.set(messageId, {
      channelId,
      seenAt: this.now(),
    })
    this.enforceEarlyEchoCap()
  }

  private registerPendingEcho(messageId: string, channelId: string): void {
    const existing = this.pendingEchoes.get(messageId)
    if (existing) this.options.scheduler.clearTimeout(existing.timer)
    const timer = this.options.scheduler.setTimeout(() => {
      this.pendingEchoes.delete(messageId)
      this.beginEchoRecovery(messageId)
    }, this.options.echoTimeoutMs)
    this.pendingEchoes.set(messageId, { channelId, timer })
    while (this.pendingEchoes.size > this.options.pendingCap) {
      const oldestId = this.pendingEchoes.keys().next().value as string | undefined
      if (!oldestId) break
      const oldest = this.pendingEchoes.get(oldestId)
      if (oldest) this.options.scheduler.clearTimeout(oldest.timer)
      this.pendingEchoes.delete(oldestId)
    }
  }

  private beginEchoRecovery(messageId: string): void {
    if (this.episode) return
    this.episode = {
      key: `gateway-recovery-${++this.episodeSequence}`,
      forced: false,
      alerted: false,
    }
    this.clearPendingEchoes()
    this.beginForcedRecovery(`Discord gateway self echo timed out for message ${messageId}`)
  }

  private beginForcedRecovery(reason: string): void {
    const episode = this.episode
    if (!episode || episode.forced) return
    episode.forced = true
    this.clearReconnectDeadline()

    if (!this.consumeForcedReconnectBudget()) {
      episode.budgetLatched = true
      this.clearPendingEchoes()
      this.scheduleBudgetLatchRelease()
      this.failEpisode(
        'Discord gateway forced reconnect budget exhausted after ' +
        '3 attempts in a rolling 60 minutes; restart the Discord plugin ' +
        'process for immediate manual recovery',
      )
      return
    }

    // Start the evidence deadline before dispatching the reconnect. The raw-shard
    // operation is intentionally fire-and-forget; only shardResume/shardReady can
    // prove recovery, never resolution of destroy().
    this.reconnectDeadline = this.options.scheduler.setTimeout(() => {
      this.reconnectDeadline = undefined
      this.failEpisode('Discord gateway forced reconnect did not produce shardResume or shardReady')
    }, this.options.recoveryDeadlineMs)
    void Promise.resolve()
      .then(() => this.options.forceReconnect(reason))
      .catch(error => {
        this.failEpisode(`Discord gateway forced reconnect failed: ${formatError(error)}`)
      })
  }

  private failEpisode(body: string): void {
    const episode = this.episode
    if (!episode || episode.alerted) return
    episode.alerted = true
    this.clearReconnectDeadline()
    const failure = { episodeKey: episode.key, body }
    this.log(body)
    void this.options.alertFailure(failure).catch(error => {
      this.log(`gateway failure alert delivery threw: ${formatError(error)}`)
    })
  }

  private finishRecovery(): void {
    if (this.episode?.budgetLatched) {
      this.log(
        'gateway recovery evidence ignored while forced reconnect budget is latched',
      )
      return
    }
    this.clearReconnectDeadline()
    this.clearPendingEchoes()
    this.episode = undefined
  }

  private clearPendingEchoes(): void {
    for (const pending of this.pendingEchoes.values()) {
      this.options.scheduler.clearTimeout(pending.timer)
    }
    this.pendingEchoes.clear()
    this.earlySelfEchoes.clear()
  }

  private pruneEarlySelfEchoes(): void {
    const cutoff = this.now() - 2 * this.options.echoTimeoutMs
    for (const [messageId, early] of this.earlySelfEchoes) {
      if (early.seenAt < cutoff) this.earlySelfEchoes.delete(messageId)
    }
  }

  private enforceEarlyEchoCap(): void {
    while (this.earlySelfEchoes.size > this.options.earlyEchoCap) {
      let oldestId: string | undefined
      let oldestSeenAt = Number.POSITIVE_INFINITY
      for (const [messageId, early] of this.earlySelfEchoes) {
        if (early.seenAt < oldestSeenAt) {
          oldestSeenAt = early.seenAt
          oldestId = messageId
        }
      }
      if (!oldestId) break
      this.earlySelfEchoes.delete(oldestId)
    }
  }

  private now(): number {
    return typeof this.options.scheduler.nowMs === 'number'
      ? this.options.scheduler.nowMs
      : Date.now()
  }

  private consumeForcedReconnectBudget(): boolean {
    this.pruneForcedReconnectAttempts()
    if (this.forcedReconnectAttempts.length >= FORCED_RECONNECT_BUDGET) {
      return false
    }
    this.forcedReconnectAttempts.push(this.now())
    return true
  }

  private pruneForcedReconnectAttempts(): void {
    const cutoff = this.now() - FORCED_RECONNECT_WINDOW_MS
    while (
      this.forcedReconnectAttempts.length > 0 &&
      this.forcedReconnectAttempts[0] <= cutoff
    ) {
      this.forcedReconnectAttempts.shift()
    }
  }

  private scheduleBudgetLatchRelease(): void {
    if (this.budgetLatchDeadline !== undefined) return
    this.pruneForcedReconnectAttempts()
    const oldestAttempt = this.forcedReconnectAttempts[0]
    const delayMs = oldestAttempt === undefined
      ? 0
      : Math.max(0, oldestAttempt + FORCED_RECONNECT_WINDOW_MS - this.now())
    this.budgetLatchDeadline = this.options.scheduler.setTimeout(() => {
      this.budgetLatchDeadline = undefined
      this.pruneForcedReconnectAttempts()
      if (!this.episode?.budgetLatched) return
      this.clearPendingEchoes()
      this.episode = undefined
      this.log('gateway forced reconnect rolling budget window expired; probe re-enabled')
    }, delayMs)
  }

  private log(message: string): void {
    try {
      this.options.log(message)
    } catch {
      // Health instrumentation is never allowed to turn an accepted Discord
      // send into a retry (and therefore a duplicate visible message).
    }
  }

  private clearReconnectDeadline(): void {
    if (this.reconnectDeadline === undefined) return
    this.options.scheduler.clearTimeout(this.reconnectDeadline)
    this.reconnectDeadline = undefined
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
