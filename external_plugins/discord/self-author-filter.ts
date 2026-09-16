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
  private ready = false
  private invalid = false
  constructor(private readonly guard = selfAuthorAllowed) {}
  connected(id: string | undefined): void {
    this.ready = false
    if (this.invalid || !id || !/^\d{17,20}$/.test(id)) return
    if (this.botId && this.botId !== id) { this.invalid = true; return }
    this.botId ??= id
    this.ready = true
  }
  disconnected(): void { this.ready = false }
  checkCurrent(id: string | undefined, ready: boolean): void {
    if (!ready || !id || id !== this.botId) this.ready = false
    if (id && this.botId && id !== this.botId) this.invalid = true
  }
  allows(authorId: string): boolean { return this.guard(this.botId, this.ready, authorId) }
  isSelf(authorId: string): boolean { return Boolean(this.botId && this.botId === authorId) }
  observe(recorderEnabled: boolean): SelfFilterObservation {
    const ready = this.ready && recorderEnabled
    const other = this.botId === '100000000000000001' ? '100000000000000002' : '100000000000000001'
    return { botUserId: this.botId ?? '', ready,
      selfDropped: !this.guard(this.botId, ready, this.botId ?? ''),
      unknownDropped: !this.guard(undefined, true, other) && !this.guard(this.botId, false, other),
      otherPassed: this.guard(this.botId, ready, other),
    }
  }
}

/** The one registered messageCreate callback guards all downstream delivery modes. */
export function attachSelfAuthorFilter<T extends { author: { id: string } }>(
  client: Pick<EventEmitter, 'on'> & { user: { id: string } | null | undefined; isReady(): boolean },
  filter: SelfAuthorFilter,
  effects: { onOther(msg: T): void; onSelfEcho(msg: T): void },
): void {
  const ready = () => { if (client.isReady()) filter.connected(client.user?.id); else filter.disconnected() }
  client.on('ready', ready)
  client.on('clientReady', ready)
  client.on('shardResume', ready)
  client.on('shardReady', ready)
  for (const event of ['shardDisconnect', 'shardReconnecting', 'invalidated']) client.on(event, () => filter.disconnected())
  client.on('messageCreate', (msg: T) => {
    filter.checkCurrent(client.user?.id, client.isReady())
    if (!filter.allows(msg.author.id)) {
      if (filter.isSelf(msg.author.id)) effects.onSelfEcho(msg)
      return
    }
    effects.onOther(msg)
  })
}
