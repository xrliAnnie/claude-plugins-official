import { afterEach, expect, it, spyOn } from 'bun:test'
import * as fs from 'node:fs'
import * as net from 'node:net'
import {
 lstatSync,
 mkdtempSync,
 readFileSync,
 readdirSync,
 rmSync,
 symlinkSync,
 unlinkSync,
 writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createConnection, createServer } from 'node:net'
import { createHmac } from 'node:crypto'
import { VoiceSelfFilterSocket, type OwnerLock } from './voice-self-filter-socket'
const leadId = 'lead', bot = '100000000000000005', secret = 'fixture-secret'
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function path() { const root = mkdtempSync(join(tmpdir(), 'cfprobe-')); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return join(root, 'v.sock') }
const observation = () => ({ botUserId: bot, ready: true, selfDropped: true, unknownDropped: true, otherPassed: true })
function fakeOwnerLock(onClose: () => void = () => {}): OwnerLock {
 return { close: onClose }
}
function fakeLockOptions(onClose: () => void = () => {}) {
 return { platform: 'darwin' as const, acquireOwnerLock: () => fakeOwnerLock(onClose) }
}
function request(over: Record<string, unknown> = {}) {
 const r: any = { version: 1, method: 'probeVoiceSelfFilter', leadId, expectedBotUserId: bot, nonce: 'a'.repeat(64), ...over }
 r.auth = createHmac('sha256', secret).update(JSON.stringify([1, 'voice-self-filter-v1', r.leadId, r.expectedBotUserId, r.nonce])).digest('hex'); return r
}
async function send(socketPath: string, body: unknown): Promise<any> {
 return new Promise((resolve, reject) => {
 const peer = createConnection(socketPath); let raw = ''
 const timer = setTimeout(() => { peer.destroy(); reject(new Error('deadline')) }, 2500)
 peer.once('connect', () => peer.write(typeof body === 'string' ? body : JSON.stringify(body) + '\n'))
 peer.on('data', b => { raw += b }); peer.on('error', () => {})
 peer.once('close', () => { clearTimeout(timer); resolve(raw ? JSON.parse(raw) : null) })
 })
}
async function start(socketPath = path()) {
 const server = new VoiceSelfFilterSocket({ socketPath, leadId, secret, observe: observation, ...fakeLockOptions() })
 expect(await server.listen()).toMatchObject({ status: 'bound' })
 cleanup.push(() => server.close()); return { server, socketPath }
}
it('signs nonce-bound live proof on an owner-only socket', async () => {
 const { socketPath } = await start(); expect(lstatSync(socketPath).mode & 0o777).toBe(0o600)
 const r = await send(socketPath, request())
 expect(r).toMatchObject({ version: 1, leadId, botUserId: bot, nonce: 'a'.repeat(64), ready: true, selfDropped: true, unknownDropped: true, otherPassed: true })
 expect(r.auth).toBe(createHmac('sha256', secret).update(JSON.stringify([1, r.leadId, r.botUserId, r.runtimeId, r.nonce, r.ready, r.selfDropped, r.unknownDropped, r.otherPassed])).digest('hex'))
})
it.each([{ leadId: 'other' }, { version: 2 }, { nonce: 'short' }, { method: 'submitBatch' }, { extra: 1 }])('rejects malformed/cross-Lead request %j', async (over) => {
 const { socketPath } = await start(); expect(await send(socketPath, request(over))).toBeNull()
})
it('rejects wrong MAC and oversized input without observing', async () => {
 let calls = 0; const socketPath = path()
 const server = new VoiceSelfFilterSocket({ socketPath, leadId, secret, observe: () => { calls++; return observation() }, ...fakeLockOptions() })
 await server.listen(); cleanup.push(() => server.close())
 expect(await send(socketPath, { ...request(), auth: 'b'.repeat(64) })).toBeNull(); expect(await send(socketPath, 'x'.repeat(4097))).toBeNull(); expect(calls).toBe(0)
})
it('never steals active sockets or unlinks symlinks/unproven stale paths', async () => {
 const { socketPath } = await start()
 expect(await new VoiceSelfFilterSocket({
  socketPath,
  leadId,
  secret,
  observe: observation,
  platform: 'darwin',
  acquireOwnerLock: () => 'busy',
 }).listen()).toEqual({ status: 'busy' })
 expect((await send(socketPath, request())).ready).toBe(true)
 const link = path(); symlinkSync(socketPath, link)
 expect(await new VoiceSelfFilterSocket({ socketPath: link, leadId, secret, observe: observation, ...fakeLockOptions() }).listen()).toEqual({ status: 'blocked', reason: 'path_symlink' }); expect(lstatSync(link).isSymbolicLink()).toBe(true)
})
it('does not unlink a replacement path on close', async () => {
 const { server, socketPath } = await start(); unlinkSync(socketPath); writeFileSync(socketPath, 'replacement')
 await server.close(); expect(readFileSync(socketPath, 'utf8')).toBe('replacement')
})

it('serves a Node Bridge client over newline framing without requiring EOF', async () => {
 const { socketPath } = await start()
 const { execFile } = await import('node:child_process')
 const script = `import { createConnection } from 'node:net';
 const peer = createConnection(process.argv[1]); let raw='';
 const timer=setTimeout(()=>{peer.destroy();process.exit(2)},2000);
 peer.once('connect',()=>peer.write(process.argv[2]+'\\n'));
 peer.on('data',b=>raw+=b); peer.once('end',()=>{clearTimeout(timer);console.log(raw);peer.destroy()});
 peer.on('error',()=>process.exit(3));`
 const raw = await new Promise<string>((resolve, reject) => execFile('node', ['--input-type=module', '-e', script, socketPath, JSON.stringify(request())], { timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout)))
 expect(JSON.parse(raw)).toMatchObject({ ready: true, botUserId: bot, leadId })
})

it('closes both owned socket links without leaving a private bind path', async () => {
 const { server, socketPath } = await start()
 await server.close(); await server.close()
 expect(readdirSync(dirname(socketPath))).toEqual([])
})

function manualScheduler() {
 const queue: Array<{ delay: number; run: () => void | Promise<void> }> = []
 return {
  queue,
  schedule(run: () => void | Promise<void>, delay: number) {
   queue.push({ delay, run })
   return { unref() {} }
  },
 }
}

it.skipIf(process.platform !== 'darwin')('reclaims a crashed owner only after the kernel releases its lock', async () => {
 const socketPath = path()
 const moduleUrl = new URL('./voice-self-filter-socket.ts', import.meta.url).href
 const script = `import { VoiceSelfFilterSocket } from ${JSON.stringify(moduleUrl)};
const server = new VoiceSelfFilterSocket({
 socketPath: ${JSON.stringify(socketPath)}, leadId: ${JSON.stringify(leadId)}, secret: ${JSON.stringify(secret)},
 observe: () => ({ botUserId: ${JSON.stringify(bot)}, ready: true, selfDropped: true, unknownDropped: true, otherPassed: true }),
});
const result = await server.listen();
console.log(JSON.stringify(result));
await new Promise(() => {});`
 const child = Bun.spawn(['bun', '--eval', script], { stdout: 'pipe', stderr: 'pipe' })
 cleanup.push(() => { try { child.kill(9) } catch {} })
 const reader = child.stdout.getReader()
 const first = await reader.read()
 expect(new TextDecoder().decode(first.value)).toContain('"status":"bound"')
 await reader.cancel()
 expect(readdirSync(dirname(socketPath)).filter(name => name === 'v.sock' || /^\.v[0-9a-f]{12}$/.test(name))).toHaveLength(2)

 child.kill(9)
 await child.exited
 const replacement = new VoiceSelfFilterSocket({ socketPath, leadId, secret, observe: observation })
 const result = await replacement.listen()
 cleanup.push(() => replacement.close())
 expect(result).toEqual({ status: 'bound', reclaimedStale: true })
 expect((await send(socketPath, request())).ready).toBe(true)
 expect(readdirSync(dirname(socketPath)).filter(name => /^\.v[0-9a-f]{12}$/.test(name))).toHaveLength(1)
})

it.skipIf(process.platform !== 'darwin')('keeps a live lock owner and hands over on the next retry', async () => {
 const socketPath = path()
 const first = new VoiceSelfFilterSocket({ socketPath, leadId, secret, observe: observation })
 const second = new VoiceSelfFilterSocket({ socketPath, leadId, secret, observe: observation })
 cleanup.push(() => first.close(), () => second.close())
 expect(await first.listen()).toMatchObject({ status: 'bound' })

 const scheduler = manualScheduler()
 const states: string[] = []
 await second.maintain({ report: state => { states.push(state) }, schedule: scheduler.schedule })
 expect(states).toEqual(['busy'])
 expect((await send(socketPath, request())).ready).toBe(true)
 expect(scheduler.queue[0]?.delay).toBe(5000)

 await first.close()
 await scheduler.queue.shift()?.run()
 expect(states).toEqual(['busy', 'bound'])
 expect((await send(socketPath, request())).ready).toBe(true)
})

it.skipIf(process.platform !== 'darwin')('never lets a closing owner unlink its successor across 50 handovers', async () => {
 for (let iteration = 0; iteration < 50; iteration += 1) {
  const socketPath = path()
  const first = new VoiceSelfFilterSocket({ socketPath, leadId, secret, observe: observation })
  const second = new VoiceSelfFilterSocket({ socketPath, leadId, secret, observe: observation })
  expect(await first.listen()).toMatchObject({ status: 'bound' })
  const firstRuntime = (await send(socketPath, request())).runtimeId
  const scheduler = manualScheduler()
  const states: string[] = []

  const closing = first.close()
  await second.maintain({ report: state => { states.push(state) }, schedule: scheduler.schedule })
  await closing
  if (!states.includes('bound')) await scheduler.queue.shift()?.run()

  const successor = await send(socketPath, request())
  expect(successor.runtimeId).not.toBe(firstRuntime)
  expect(lstatSync(socketPath).isSocket()).toBe(true)
  await second.close()
 }
})

it('releases a fake owner lock without touching unsafe public paths', async () => {
 const cases: Array<{
  reason: string
  setup(socketPath: string): Promise<void> | void
  assertPreserved(socketPath: string): void
  getuid?: () => number
 }> = [
  {
   reason: 'path_symlink',
   setup(socketPath) { const target = `${socketPath}.target`; writeFileSync(target, 'target'); symlinkSync(target, socketPath) },
   assertPreserved(socketPath) { expect(lstatSync(socketPath).isSymbolicLink()).toBe(true) },
  },
  {
   reason: 'path_not_socket',
   setup(socketPath) { writeFileSync(socketPath, 'not a socket') },
   assertPreserved(socketPath) { expect(readFileSync(socketPath, 'utf8')).toBe('not a socket') },
  },
  {
   reason: 'path_foreign_owner',
   async setup(socketPath) {
    const raw = createServer()
    await new Promise<void>((resolve, reject) => { raw.once('error', reject); raw.listen(socketPath, resolve) })
    cleanup.push(() => new Promise<void>(resolve => raw.close(() => resolve())))
   },
   assertPreserved(socketPath) { expect(lstatSync(socketPath).isSocket()).toBe(true) },
   getuid: () => (process.getuid?.() ?? 0) + 1,
  },
 ]
 for (const testCase of cases) {
  const socketPath = path()
  await testCase.setup(socketPath)
  let released = 0
  const server = new VoiceSelfFilterSocket({
   socketPath,
   leadId,
   secret,
   observe: observation,
   platform: 'darwin',
   acquireOwnerLock: () => fakeOwnerLock(() => { released += 1 }),
   getuid: testCase.getuid,
  })
  expect(await server.listen()).toEqual({ status: 'blocked', reason: testCase.reason })
  expect(released).toBe(1)
  testCase.assertPreserved(socketPath)
 }
})

it('cleans only owner sockets with the strict private-name pattern', async () => {
 const socketPath = path()
 const root = dirname(socketPath)
 const ownedPrivate = join(root, '.vabcdefabcdef')
 const nearMiss = join(root, '.vX')
 const unrelated = join(root, 'foo.sock')
 const rawServers = [ownedPrivate, nearMiss, unrelated].map(name => {
  const server = createServer()
  cleanup.push(() => new Promise<void>(resolve => server.close(() => resolve())))
  return { name, server }
 })
 for (const entry of rawServers) {
  await new Promise<void>((resolve, reject) => { entry.server.once('error', reject); entry.server.listen(entry.name, resolve) })
 }
 const server = new VoiceSelfFilterSocket({ socketPath, leadId, secret, observe: observation, ...fakeLockOptions() })
 cleanup.push(() => server.close())
 expect(await server.listen()).toEqual({ status: 'bound', reclaimedStale: true })
 expect(() => lstatSync(ownedPrivate)).toThrow()
 expect(lstatSync(nearMiss).isSocket()).toBe(true)
 expect(lstatSync(unrelated).isSocket()).toBe(true)
})

it.skipIf(process.platform !== 'darwin')('refuses a symlinked kernel lock file', async () => {
 const socketPath = path()
 const target = join(dirname(socketPath), 'lock-target')
 writeFileSync(target, 'target')
 symlinkSync(target, join(dirname(socketPath), 'voice-self-filter.lock'))
 const server = new VoiceSelfFilterSocket({ socketPath, leadId, secret, observe: observation })

 expect(await server.listen()).toEqual({ status: 'blocked', reason: 'lock_unsafe' })
 expect(lstatSync(join(dirname(socketPath), 'voice-self-filter.lock')).isSymbolicLink()).toBe(true)
})

it('rebinds after an external public-path deletion on the health check', async () => {
 const socketPath = path()
 let locksReleased = 0
 const scheduler = manualScheduler()
 const states: string[] = []
 const server = new VoiceSelfFilterSocket({
  socketPath,
  leadId,
  secret,
  observe: observation,
  platform: 'darwin',
  acquireOwnerLock: () => fakeOwnerLock(() => { locksReleased += 1 }),
 })
 cleanup.push(() => server.close())
 await server.maintain({ report: state => { states.push(state) }, schedule: scheduler.schedule })
 expect(states).toEqual(['bound'])
 expect(scheduler.queue[0]?.delay).toBe(30000)

 unlinkSync(socketPath)
 await scheduler.queue.shift()?.run()
 expect(states).toEqual(['bound', 'blocked:path_missing', 'bound'])
 expect(locksReleased).toBe(1)
 expect((await send(socketPath, request())).ready).toBe(true)
})

it('fails closed once on unsupported platforms without acquiring or observing', async () => {
 const socketPath = path()
 const stderr: string[] = []
 let observed = 0
 const server = new VoiceSelfFilterSocket({
  socketPath,
  leadId,
  secret,
  observe: () => { observed += 1; return observation() },
  platform: 'linux',
  acquireOwnerLock: () => { throw new Error('must not acquire') },
  stderr: line => { stderr.push(line) },
 })

 expect(await server.listen()).toEqual({ status: 'unsupported' })
 expect(await server.listen()).toEqual({ status: 'unsupported' })
 expect(observed).toBe(0)
 expect(stderr).toEqual(['voice self-filter probe unsupported on linux; voice admission remains closed\n'])
 expect(readdirSync(dirname(socketPath))).toEqual([])
})


it('retries a first maintain exception and stops retrying after close', async () => {
 const socketPath = path()
 const scheduler = manualScheduler()
 const states: string[] = []
 let first = true
 let released = 0
 const server = new VoiceSelfFilterSocket({ socketPath, leadId, secret, observe: observation, platform: 'darwin',
  acquireOwnerLock: () => { if (first) { first = false; throw new Error('initial failure') } return fakeOwnerLock(() => { released++ }) },
 })
 cleanup.push(() => server.close())
 await expect(server.maintain({ report: state => { states.push(state) }, schedule: scheduler.schedule })).resolves.toBeUndefined()
 expect(states).toEqual(['blocked:internal_error'])
 expect(scheduler.queue).toHaveLength(1)
 expect(scheduler.queue[0]?.delay).toBe(5000)
 await server.maintain({ report: () => { throw new Error('duplicate maintain') }, schedule: scheduler.schedule })
 expect(scheduler.queue).toHaveLength(1)
 await scheduler.queue.shift()?.run()
 expect(states).toEqual(['blocked:internal_error', 'bound'])
 expect((await send(socketPath, request())).ready).toBe(true)
 await server.close()
 expect(released).toBe(1)
 await scheduler.queue.shift()?.run()
 expect(readdirSync(dirname(socketPath))).toEqual([])
})

it('releases an acquired owner lock when identity lookup throws before bind', async () => {
 const socketPath = path()
 let released = 0
 let first = true
 const server = new VoiceSelfFilterSocket({ socketPath, leadId, secret, observe: observation, ...fakeLockOptions(() => { released++ }),
  getuid: () => { if (first) { first = false; throw new Error('uid failed') } return process.getuid?.() ?? 0 },
 })
 cleanup.push(() => server.close())
 await expect(server.listen()).rejects.toThrow('uid failed')
 expect(released).toBe(1)
 expect(await server.listen()).toMatchObject({ status: 'bound' })
 expect((await send(socketPath, request())).ready).toBe(true)
})

it.each(['post-bind-stat', 'unpublished-unlink'])('closes listener and releases lock after %s failure, then maintain retries', async (failure) => {
 const socketPath = path()
 const scheduler = manualScheduler()
 const states: string[] = []
 let released = 0
 const servers: net.Server[] = []
 const create = net.createServer
 const stat = fs.lstatSync
 const link = fs.linkSync
 const unlink = fs.unlinkSync
 const createSpy = spyOn(net, 'createServer').mockImplementation((...args: any[]) => { const server = (create as any)(...args); servers.push(server); return server })
 cleanup.push(() => createSpy.mockRestore())
 // Close even an original-code leaked listener so the red test itself exits.
 cleanup.push(async () => { for (const server of servers) if (server.listening) await new Promise<void>(resolve => server.close(() => resolve())) })
 let once = true
 let unlinkFailed = false
 const statSpy = spyOn(fs, 'lstatSync').mockImplementation((name: any, ...args: any[]) => {
  if (failure === 'post-bind-stat' && once && /\.v[0-9a-f]{12}$/.test(String(name))) { once = false; throw Object.assign(new Error('stat failed'), { code: 'EIO' }) }
  return (stat as any)(name, ...args)
 })
 const linkSpy = spyOn(fs, 'linkSync').mockImplementation((...args: any[]) => {
  if (failure === 'unpublished-unlink' && once) { once = false; unlinkFailed = true; throw Object.assign(new Error('link failed'), { code: 'EACCES' }) }
  return (link as any)(...args)
 })
 const unlinkSpy = spyOn(fs, 'unlinkSync').mockImplementation((name: any) => {
  if (unlinkFailed && /\.v[0-9a-f]{12}$/.test(String(name))) { unlinkFailed = false; throw Object.assign(new Error('unlink failed'), { code: 'EACCES' }) }
  return unlink(name)
 })
 cleanup.push(() => { statSpy.mockRestore(); linkSpy.mockRestore(); unlinkSpy.mockRestore() })
 const server = new VoiceSelfFilterSocket({ socketPath, leadId, secret, observe: observation, ...fakeLockOptions(() => { released++ }) })
 cleanup.push(() => server.close())
 await expect(server.maintain({ report: state => { states.push(state) }, schedule: scheduler.schedule })).resolves.toBeUndefined()
 expect(states).toEqual(['blocked:internal_error'])
 expect(released).toBe(1)
 expect(servers[0]?.listening).toBe(false)
 expect(scheduler.queue[0]?.delay).toBe(5000)
 await scheduler.queue.shift()?.run()
 expect(states.at(-1)).toBe('bound')
 expect((await send(socketPath, request())).ready).toBe(true)
})
