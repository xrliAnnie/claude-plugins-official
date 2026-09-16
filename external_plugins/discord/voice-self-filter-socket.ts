import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, lstatSync, unlinkSync } from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import type { SelfFilterObservation } from './self-author-filter'
const LIMIT = 4096
const hex = /^[a-f0-9]{64}$/

/** Read-only proof from this carrier. Never takes over an existing pathname. */
export class VoiceSelfFilterSocket {
  private server?: Server
  private bound?: { dev: number; ino: number }
  private readonly peers = new Set<Socket>()
  private readonly runtimeId = randomUUID()
  constructor(private readonly opts: { socketPath: string; leadId: string; secret: string; observe(): SelfFilterObservation }) {
    if (!opts.socketPath || !opts.leadId || !opts.secret) throw new Error('voice_self_filter_config_missing')
  }
  async listen(): Promise<void> {
    if (this.server) return
    try { lstatSync(this.opts.socketPath); throw new Error('voice_self_filter_path_exists') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const server = createServer({ allowHalfOpen: true }, peer => this.accept(peer))
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.opts.socketPath, () => { server.removeListener('error', reject); resolve() })
    })
    this.server = server
    const stat = lstatSync(this.opts.socketPath)
    this.bound = { dev: stat.dev, ino: stat.ino }
    try { chmodSync(this.opts.socketPath, 0o600) } catch (error) { await this.close(); throw error }
  }
  async close(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined
    for (const peer of this.peers) peer.destroy()
    await new Promise<void>(resolve => server.close(() => resolve()))
    try {
      const stat = lstatSync(this.opts.socketPath)
      if (stat.isSocket() && stat.dev === this.bound?.dev && stat.ino === this.bound?.ino) unlinkSync(this.opts.socketPath)
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.bound = undefined
  }
  private accept(peer: Socket): void {
    this.peers.add(peer)
    const timer = setTimeout(() => peer.destroy(), 2000)
    peer.once('close', () => { clearTimeout(timer); this.peers.delete(peer) })
    peer.on('error', () => {})
    let size = 0
    const chunks: Buffer[] = []
    let answered = false
    const respond = (raw: string) => {
      if (answered || size > LIMIT) return
      answered = true
      try {
        const request = JSON.parse(raw)
        if (!request || request.version !== 1 || request.method !== 'probeVoiceSelfFilter' || request.leadId !== this.opts.leadId ||
          typeof request.expectedBotUserId !== 'string' || !/^\d{17,20}$/.test(request.expectedBotUserId) ||
          typeof request.nonce !== 'string' || !hex.test(request.nonce) || typeof request.auth !== 'string' || !hex.test(request.auth) ||
          Object.keys(request).some(k => !['version', 'method', 'leadId', 'expectedBotUserId', 'nonce', 'auth'].includes(k))) throw new Error('invalid_request')
        const signature = this.mac(JSON.stringify([1, 'voice-self-filter-v1', request.leadId, request.expectedBotUserId, request.nonce]))
        if (!timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(request.auth, 'hex'))) throw new Error('invalid_auth')
        const result = { version: 1, leadId: this.opts.leadId, runtimeId: this.runtimeId, nonce: request.nonce, ...this.opts.observe() }
        const auth = this.mac(JSON.stringify([1, result.leadId, result.botUserId, result.runtimeId, result.nonce, result.ready, result.selfDropped, result.unknownDropped, result.otherPassed]))
        const reply = JSON.stringify({ ...result, auth }) + '\n'
        if (Buffer.byteLength(reply) > LIMIT) throw new Error('invalid_observation')
        peer.end(reply)
      } catch { peer.destroy() }
    }
    peer.on('data', (chunk: Buffer) => {
      if (answered) return
      size += chunk.length
      if (size > LIMIT) { answered = true; peer.destroy(); return }
      chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.includes('\n')) respond(raw)
    })
    peer.once('end', () => respond(Buffer.concat(chunks).toString('utf8')))
  }
  private mac(value: string): string { return createHmac('sha256', this.opts.secret).update(value).digest('hex') }
}
