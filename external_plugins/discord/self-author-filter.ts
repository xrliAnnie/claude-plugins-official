import type { EventEmitter } from 'node:events'

export function selfAuthorAllowed(botId: string | undefined, ready: boolean, authorId: string): boolean {
  return Boolean(ready && botId && authorId && authorId !== botId)
}

export interface SelfFilterObservation {
  botUserId: string
  ready: boolean
  selfDropped: boolean
  unknownDropped: boolean
  otherPassed: boolean
}

export class SelfAuthorFilter {
  private botId?: string
  private invalid = false
  private connected = false

  constructor(
    private readonly guard = selfAuthorAllowed,
    private readonly onInvalid: (seen: string) => void = () => {},
  ) {}

  pin(id: string | undefined): void {
    if (this.invalid) return
    if (!id || !/^\d{17,20}$/.test(id)) {
      this.connected = false
      return
    }
    if (this.botId && this.botId !== id) {
      this.noteCurrent(id)
      return
    }
    this.botId ??= id
    this.connected = true
  }

  disconnected(): void {
    this.connected = false
  }

  noteCurrent(id: string | undefined): void {
    if (this.invalid || !id || !this.botId || id === this.botId) return
    this.invalid = true
    this.connected = false
    this.onInvalid(id)
  }

  identityValid(): boolean {
    return Boolean(this.botId) && !this.invalid
  }

  allowsIntake(authorId: string): boolean {
    return this.guard(this.botId, this.identityValid(), authorId)
  }

  isSelf(authorId: string): boolean {
    return Boolean(this.botId && this.botId === authorId)
  }

  observe(params: {
    recorderEnabled: boolean
    currentUserId?: string
    clientReady: boolean
  }): SelfFilterObservation {
    this.noteCurrent(params.currentUserId)
    const ready = Boolean(
      this.connected &&
      params.clientReady &&
      this.identityValid() &&
      params.currentUserId === this.botId &&
      params.recorderEnabled
    )
    const other = this.botId === '100000000000000001'
      ? '100000000000000002'
      : '100000000000000001'
    return {
      botUserId: this.botId ?? '',
      ready,
      selfDropped: !this.guard(this.botId, ready, this.botId ?? ''),
      unknownDropped:
        !this.guard(undefined, true, other) &&
        !this.guard(this.botId, false, other),
      otherPassed: this.guard(this.botId, ready, other),
    }
  }
}

/** The one registered messageCreate callback guards all downstream delivery modes. */
export function attachSelfAuthorFilter<
  T extends { id: string; channelId: string; author: { id: string } },
>(
  client: Pick<EventEmitter, 'on'> & {
    user: { id: string } | null | undefined
    isReady(): boolean
  },
  filter: SelfAuthorFilter,
  effects: {
    onOther(msg: T): void
    onSelfEcho(msg: T): void
    log(message: string): void
  },
): void {
  let sequence = 0
  let reconnecting = false
  let admitted = 0
  let suppressed = 0

  const logLifecycle = (event: string, closesWindow = false) => {
    sequence += 1
    const suffix = closesWindow && suppressed > 0 ? ` suppressed=${suppressed}` : ''
    effects.log(`self-filter lifecycle pid=${process.pid} seq=${sequence} event=${event}${suffix}`)
    if (closesWindow) {
      reconnecting = false
      admitted = 0
      suppressed = 0
    }
  }
  const openWindow = (event: string) => {
    filter.disconnected()
    if (!reconnecting) {
      admitted = 0
      suppressed = 0
    }
    reconnecting = true
    logLifecycle(event)
  }
  const pin = () => {
    if (client.isReady()) filter.pin(client.user?.id)
    else filter.disconnected()
  }

  client.on('ready', () => {
    pin()
    logLifecycle('ready', true)
  })
  client.on('clientReady', () => {
    pin()
    logLifecycle('ready', true)
  })
  client.on('shardResume', (_shardId: number, replayed: number) => {
    pin()
    logLifecycle(`resume replayed=${replayed}`, true)
  })
  client.on('shardReady', () => {
    pin()
    logLifecycle('ready', true)
  })
  client.on('shardDisconnect', () => { openWindow('disconnect') })
  client.on('shardReconnecting', () => { openWindow('reconnecting') })
  client.on('invalidated', () => { openWindow('invalidated') })
  client.on('messageCreate', (msg: T) => {
    filter.noteCurrent(client.user?.id)
    if (!filter.allowsIntake(msg.author.id)) {
      if (filter.isSelf(msg.author.id)) effects.onSelfEcho(msg)
      return
    }
    if (reconnecting && filter.identityValid()) {
      if (admitted < 50) {
        sequence += 1
        effects.log(
          `self-filter admitted-while-reconnecting pid=${process.pid} seq=${sequence} message=${msg.id} channel=${msg.channelId}`,
        )
        admitted += 1
      } else {
        suppressed += 1
      }
    }
    effects.onOther(msg)
  })
}
