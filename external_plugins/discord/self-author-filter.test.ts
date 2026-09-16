import { expect, it } from 'bun:test'
import { EventEmitter } from 'node:events'
import { SelfAuthorFilter, attachSelfAuthorFilter } from './self-author-filter'
const bot = '100000000000000005'
function fixture(guard?: (id: string | undefined, ready: boolean, author: string) => boolean) {
 const client = new EventEmitter() as EventEmitter & { user?: { id: string }; isReady(): boolean }
 client.isReady = () => true
 const filter = new SelfAuthorFilter(guard), received: string[] = [], echoes: string[] = []
 attachSelfAuthorFilter(client, filter, { onOther: (msg: any) => received.push(msg.author.id), onSelfEcho: (msg: any) => echoes.push(msg.author.id) })
 const emit = (author: string) => client.emit('messageCreate', { id: 'message', channelId: 'chat', author: { id: author, bot: author === bot } })
 return { client, filter, received, echoes, emit }
}
it('drops self before any access/delivery callback, normal founder proceeds', () => {
 const f = fixture(); f.client.user = { id: bot }; f.client.emit('ready', f.client); f.emit(bot); f.emit('founder')
 expect(f.received).toEqual(['founder']); expect(f.echoes).toEqual([bot])
 expect(f.filter.observe(true)).toMatchObject({ botUserId: bot, ready: true, selfDropped: true, unknownDropped: true, otherPassed: true })
})
it('rejects unknown/disconnected identity and a changed ID after ready', () => {
 const f = fixture(); f.emit('founder'); expect(f.received).toEqual([])
 f.client.user = { id: bot }; f.client.emit('ready', f.client); f.client.emit('shardDisconnect'); f.client.user = undefined; f.emit(bot); f.emit('founder')
 expect(f.received).toEqual([]); expect(f.filter.observe(true).ready).toBe(false)
 f.client.user = { id: bot }; f.client.emit('shardResume'); f.emit(bot); f.emit('founder'); expect(f.received).toEqual(['founder'])
 f.client.user = { id: '100000000000000099' }; f.client.emit('ready', f.client); f.emit('founder')
 expect(f.filter.observe(true).ready).toBe(false); expect(f.received).toEqual(['founder'])
})
it('keeps voice unavailable in broken/legacy mode without bypassing self guard', () => {
 const f = fixture(); f.client.user = { id: bot }; f.client.emit('ready', f.client)
 expect(f.filter.observe(false).ready).toBe(false); f.emit(bot); expect(f.received).toEqual([])
})
it('probe detects mutation of the same guard used by the registered callback', () => {
 const f = fixture(() => true); f.client.user = { id: bot }; f.client.emit('ready', f.client); f.emit(bot)
 expect(f.received).toEqual([bot]); expect(f.filter.observe(true)).toMatchObject({ selfDropped: false, unknownDropped: false })
})

it('drops all intake if client.user disappears without a lifecycle event', () => {
 const f = fixture(); f.client.user = { id: bot }; f.client.emit('ready', f.client)
 f.client.user = undefined; f.emit('founder'); f.emit(bot)
 expect(f.received).toEqual([]); expect(f.filter.observe(true).ready).toBe(false)
})
