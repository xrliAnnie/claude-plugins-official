import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  unlinkSync,
} from 'node:fs'
import { createServer, type Server, type Socket } from 'node:net'
import { dirname, join } from 'node:path'
import type { SelfFilterObservation } from './self-author-filter'

const LIMIT = 4096
const hex = /^[a-f0-9]{64}$/
const privateSocketName = /^\.v[0-9a-f]{12}$/

export interface OwnerLock {
  close(): void
}

export type VoiceSelfFilterListenResult =
  | { status: 'bound'; reclaimedStale: boolean }
  | { status: 'busy' }
  | { status: 'blocked'; reason: string }
  | { status: 'unsupported' }

interface VoiceSelfFilterSocketOptions {
  socketPath: string
  leadId: string
  secret: string
  observe(): SelfFilterObservation
  platform?: NodeJS.Platform
  getuid?: () => number
  acquireOwnerLock?: () => OwnerLock | 'busy' | 'blocked'
  stderr?: (line: string) => void
}

interface MaintainOptions {
  report(state: string): void
  schedule?: (
    run: () => void | Promise<void>,
    delayMs: number,
  ) => { unref(): unknown }
}

/** Read-only proof from this carrier. The kernel lock is the sole owner election. */
export class VoiceSelfFilterSocket {
  private server?: Server
  private bound?: { dev: number; ino: number }
  private listenPath?: string
  private ownerLock?: OwnerLock
  private readonly peers = new Set<Socket>()
  private readonly runtimeId = randomUUID()
  private maintaining = false
  private lastReport?: string
  private unsupportedReported = false
  private maintainOptions?: MaintainOptions

  constructor(private readonly opts: VoiceSelfFilterSocketOptions) {
    if (!opts.socketPath || !opts.leadId || !opts.secret) {
      throw new Error('voice_self_filter_config_missing')
    }
  }

  async listen(): Promise<VoiceSelfFilterListenResult> {
    if (this.server) return { status: 'bound', reclaimedStale: false }
    const platform = this.opts.platform ?? process.platform
    if (platform !== 'darwin') {
      if (!this.unsupportedReported) {
        this.unsupportedReported = true
        const stderr = this.opts.stderr ?? (line => { process.stderr.write(line) })
        stderr(
          'voice self-filter probe unsupported on ' + platform +
          '; voice admission remains closed\n',
        )
      }
      return { status: 'unsupported' }
    }

    const acquired = this.opts.acquireOwnerLock?.() ?? this.acquireOwnerLock()
    if (acquired === 'busy') return { status: 'busy' }
    if (acquired === 'blocked') return { status: 'blocked', reason: 'lock_unsafe' }
    const ownerLock = acquired
    let reclaimedStale = false

    const blocked = (reason: string): VoiceSelfFilterListenResult => {
      ownerLock.close()
      return { status: 'blocked', reason }
    }
    const uid = this.opts.getuid?.() ?? process.getuid?.()
    if (uid === undefined) return blocked('lock_unsafe')

    try {
      const publicStat = lstatSync(this.opts.socketPath)
      if (publicStat.isSymbolicLink()) return blocked('path_symlink')
      if (!publicStat.isSocket()) return blocked('path_not_socket')
      if (publicStat.uid !== uid) return blocked('path_foreign_owner')
      unlinkSync(this.opts.socketPath)
      reclaimedStale = true
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        return blocked('path_scan_failed')
      }
    }

    try {
      const stateDir = dirname(this.opts.socketPath)
      const stalePrivateNames = readdirSync(stateDir)
        .filter(name => privateSocketName.test(name))
        .slice(0, 64)
      for (const name of stalePrivateNames) {
        const stalePath = join(stateDir, name)
        try {
          const stat = lstatSync(stalePath)
          if (stat.isSocket() && stat.uid === uid) {
            unlinkSync(stalePath)
            reclaimedStale = true
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
            return blocked('path_scan_failed')
          }
        }
      }
    } catch {
      return blocked('path_scan_failed')
    }

    const privatePath = join(
      dirname(this.opts.socketPath),
      '.v' + randomBytes(6).toString('hex'),
    )
    const server = createServer({ allowHalfOpen: true }, peer => this.accept(peer))
    const listenError = await new Promise<unknown>(resolve => {
      const onError = (error: unknown) => { resolve(error) }
      server.once('error', onError)
      server.listen(privatePath, () => {
        server.removeListener('error', onError)
        resolve(undefined)
      })
    })
    if (listenError) {
      ownerLock.close()
      return { status: 'blocked', reason: 'bind_failed' }
    }

    const stat = lstatSync(privatePath)
    const bound = { dev: stat.dev, ino: stat.ino }
    try {
      chmodSync(privatePath, 0o600)
      linkSync(privatePath, this.opts.socketPath)
    } catch (error) {
      try {
        await this.closeUnpublished(server, privatePath, bound)
      } finally {
        ownerLock.close()
      }
      return {
        status: 'blocked',
        reason: (error as NodeJS.ErrnoException).code === 'EEXIST'
          ? 'path_raced'
          : 'bind_failed',
      }
    }

    this.server = server
    this.listenPath = privatePath
    this.bound = bound
    this.ownerLock = ownerLock
    return { status: 'bound', reclaimedStale }
  }

  async maintain(options: MaintainOptions): Promise<void> {
    if (this.maintaining) return
    this.maintaining = true
    this.maintainOptions = options
    await this.ensureMaintained()
  }

  async close(): Promise<void> {
    this.maintaining = false
    await this.closeBound()
  }

  private acquireOwnerLock(): OwnerLock | 'busy' | 'blocked' {
    const lockPath = join(dirname(this.opts.socketPath), 'voice-self-filter.lock')
    let fd: number
    try {
      fd = openSync(
        lockPath,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_NOFOLLOW |
          constants.O_NONBLOCK |
          0x20,
        0o600,
      )
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (code === 'EAGAIN' || code === 'EWOULDBLOCK') return 'busy'
      return 'blocked'
    }
    let stat: ReturnType<typeof fstatSync>
    try {
      stat = fstatSync(fd)
    } catch {
      closeSync(fd)
      return 'blocked'
    }
    const uid = this.opts.getuid?.() ?? process.getuid?.()
    if (!stat.isFile() || uid === undefined || stat.uid !== uid) {
      closeSync(fd)
      return 'blocked'
    }
    let closed = false
    return {
      close() {
        if (closed) return
        closed = true
        closeSync(fd)
      },
    }
  }

  private async ensureMaintained(): Promise<void> {
    if (!this.maintaining || !this.maintainOptions) return
    if (this.server && !this.publishedPathOwned()) {
      let reason = 'path_replaced'
      try {
        lstatSync(this.opts.socketPath)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') reason = 'path_missing'
      }
      this.report('blocked:' + reason)
      await this.closeBound()
    }

    const result = this.server
      ? { status: 'bound', reclaimedStale: false } as const
      : await this.listen()
    if (result.status === 'bound') {
      if (result.reclaimedStale) this.report('reclaimed stale')
      this.report('bound')
      this.schedule(30000)
      return
    }
    if (result.status === 'blocked') this.report('blocked:' + result.reason)
    else this.report(result.status)
    if (result.status !== 'unsupported') this.schedule(5000)
  }

  private schedule(delayMs: number): void {
    if (!this.maintaining || !this.maintainOptions) return
    const schedule = this.maintainOptions.schedule ?? ((run, delay) => {
      const timer = setTimeout(() => { void run() }, delay)
      return timer
    })
    schedule(async () => {
      try {
        await this.ensureMaintained()
      } catch {
        this.report('blocked:internal_error')
        this.schedule(5000)
      }
    }, delayMs).unref()
  }

  private report(state: string): void {
    if (state === this.lastReport) return
    this.lastReport = state
    this.maintainOptions?.report(state)
  }

  private publishedPathOwned(): boolean {
    try {
      const stat = lstatSync(this.opts.socketPath)
      return Boolean(
        stat.isSocket() &&
        stat.dev === this.bound?.dev &&
        stat.ino === this.bound?.ino,
      )
    } catch {
      return false
    }
  }

  private async closeBound(): Promise<void> {
    const server = this.server
    const ownerLock = this.ownerLock
    const listenPath = this.listenPath
    const bound = this.bound
    this.server = undefined
    this.ownerLock = undefined
    this.listenPath = undefined
    this.bound = undefined
    if (!server) {
      ownerLock?.close()
      return
    }
    let cleanupError: unknown
    try {
      for (const peer of this.peers) peer.destroy()
      for (const path of [this.opts.socketPath, listenPath]) {
        if (!path) continue
        this.unlinkOwned(path, bound)
      }
    } catch (error) {
      cleanupError = error
    } finally {
      await new Promise<void>(resolve => { server.close(() => resolve()) })
      ownerLock?.close()
    }
    if (cleanupError) throw cleanupError
  }

  private async closeUnpublished(
    server: Server,
    privatePath: string,
    bound: { dev: number; ino: number },
  ): Promise<void> {
    this.unlinkOwned(privatePath, bound)
    await new Promise<void>(resolve => { server.close(() => resolve()) })
  }

  private unlinkOwned(
    path: string,
    bound: { dev: number; ino: number } | undefined,
  ): void {
    try {
      const stat = lstatSync(path)
      if (stat.isSocket() && stat.dev === bound?.dev && stat.ino === bound.ino) {
        unlinkSync(path)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
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
        if (
          !request ||
          request.version !== 1 ||
          request.method !== 'probeVoiceSelfFilter' ||
          request.leadId !== this.opts.leadId ||
          typeof request.expectedBotUserId !== 'string' ||
          !/^\d{17,20}$/.test(request.expectedBotUserId) ||
          typeof request.nonce !== 'string' ||
          !hex.test(request.nonce) ||
          typeof request.auth !== 'string' ||
          !hex.test(request.auth) ||
          Object.keys(request).some(k => ![
            'version',
            'method',
            'leadId',
            'expectedBotUserId',
            'nonce',
            'auth',
          ].includes(k))
        ) throw new Error('invalid_request')
        const signature = this.mac(JSON.stringify([
          1,
          'voice-self-filter-v1',
          request.leadId,
          request.expectedBotUserId,
          request.nonce,
        ]))
        if (!timingSafeEqual(
          Buffer.from(signature, 'hex'),
          Buffer.from(request.auth, 'hex'),
        )) throw new Error('invalid_auth')
        const result = {
          version: 1,
          leadId: this.opts.leadId,
          runtimeId: this.runtimeId,
          nonce: request.nonce,
          ...this.opts.observe(),
        }
        const auth = this.mac(JSON.stringify([
          1,
          result.leadId,
          result.botUserId,
          result.runtimeId,
          result.nonce,
          result.ready,
          result.selfDropped,
          result.unknownDropped,
          result.otherPassed,
        ]))
        const reply = JSON.stringify({ ...result, auth }) + '\n'
        if (Buffer.byteLength(reply) > LIMIT) throw new Error('invalid_observation')
        peer.end(reply)
      } catch {
        peer.destroy()
      }
    }
    peer.on('data', (chunk: Buffer) => {
      if (answered) return
      size += chunk.length
      if (size > LIMIT) {
        answered = true
        peer.destroy()
        return
      }
      chunks.push(chunk)
      const raw = Buffer.concat(chunks).toString('utf8')
      if (raw.includes('\n')) respond(raw)
    })
    peer.once('end', () => respond(Buffer.concat(chunks).toString('utf8')))
  }

  private mac(value: string): string {
    return createHmac('sha256', this.opts.secret).update(value).digest('hex')
  }
}
