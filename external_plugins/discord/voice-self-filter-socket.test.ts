import { afterEach, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, readdirSync, lstatSync, symlinkSync, writeFileSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { createConnection } from 'node:net'
import { createHmac } from 'node:crypto'
import { VoiceSelfFilterSocket } from './voice-self-filter-socket'
const leadId = 'lead', bot = '100000000000000005', secret = 'fixture-secret'
const cleanup: Array<() => unknown | Promise<unknown>> = []
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn() })
function path() { const root = mkdtempSync(join(tmpdir(), 'cfprobe-')); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return join(root, 'v.sock') }
const observation = () => ({ botUserId: bot, ready: true, selfDropped: true, unknownDropped: true, otherPassed: true })
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
 const server = new VoiceSelfFilterSocket({ socketPath, leadId, secret, observe: observation })
 await server.listen(); cleanup.push(() => server.close()); return { server, socketPath }
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
 const server = new VoiceSelfFilterSocket({ socketPath, leadId, secret, observe: () => { calls++; return observation() } })
 await server.listen(); cleanup.push(() => server.close())
 expect(await send(socketPath, { ...request(), auth: 'b'.repeat(64) })).toBeNull(); expect(await send(socketPath, 'x'.repeat(4097))).toBeNull(); expect(calls).toBe(0)
})
it('never steals active sockets or unlinks symlinks/unproven stale paths', async () => {
 const { socketPath } = await start()
 await expect(new VoiceSelfFilterSocket({ socketPath, leadId, secret, observe: observation }).listen()).rejects.toThrow()
 expect((await send(socketPath, request())).ready).toBe(true)
 const link = path(); symlinkSync(socketPath, link)
 await expect(new VoiceSelfFilterSocket({ socketPath: link, leadId, secret, observe: observation }).listen()).rejects.toThrow(); expect(lstatSync(link).isSymbolicLink()).toBe(true)
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
