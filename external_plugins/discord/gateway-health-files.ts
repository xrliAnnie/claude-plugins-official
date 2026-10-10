import {
  appendFileSync,
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type { GatewayAlertDeadLetter } from './gateway-alert'
import type { GatewayStatusSnapshot } from './gateway-status'

const DEFAULT_MAX_LOG_BYTES = 256 * 1024

export interface GatewayHealthFilesOptions {
  stateDir: string
  maxLogBytes?: number
  now?: () => Date
  stderr?: (line: string) => void
}

export class GatewayHealthFiles {
  private readonly logPath: string
  private readonly backupPath: string
  private readonly deadLetterPath: string
  private readonly maxLogBytes: number
  private readonly now: () => Date
  private readonly stderr: (line: string) => void
  private logWriteDegraded = false

  constructor(private readonly options: GatewayHealthFilesOptions) {
    this.logPath = join(options.stateDir, 'gateway-health.log')
    this.backupPath = `${this.logPath}.1`
    this.deadLetterPath = join(
      options.stateDir,
      'gateway-health-dead-letter.jsonl',
    )
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES
    this.now = options.now ?? (() => new Date())
    this.stderr = options.stderr ?? (line => { process.stderr.write(line) })
  }

  writeStatus(status: GatewayStatusSnapshot, recovery?: {
    episodeKey: string | null
    forced: boolean
    budgetLatched: boolean
    attemptsInWindow: number
    guard: 'available' | 'unavailable'
  }): void {
    const bytes = Buffer.from(JSON.stringify({ ...status, ...(recovery ? { recovery } : {}) }) + '\n')
    if (bytes.length > 64 * 1024) throw new Error('gateway_status_size')
    const dir = this.options.stateDir
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    const root = lstatSync(dir)
    if (!root.isDirectory() || root.uid !== process.getuid?.() || root.mode & 0o022 ||
      realpathSync(dir) !== dir) throw new Error('gateway_status_unsafe')
    const path = join(dir, 'gateway-status.json')
    const existing = () => {
      try {
        const row = lstatSync(path)
        if (!row.isFile() || row.uid !== process.getuid?.() || row.nlink !== 1 ||
          row.mode & 0o077 || row.size > 64 * 1024) throw new Error('gateway_status_unsafe')
        return row
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw error
      }
    }
    const before = existing()
    const temp = join(dir, `.gateway-status-${randomUUID()}.tmp`)
    const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600)
    const temporary = fstatSync(fd)
    let renamed = false
    try {
      writeFileSync(fd, bytes)
      fsyncSync(fd)
      const latestRoot = lstatSync(dir), latest = existing()
      if (!latestRoot.isDirectory() || latestRoot.uid !== root.uid || latestRoot.mode & 0o022 ||
        latestRoot.dev !== root.dev || latestRoot.ino !== root.ino || realpathSync(dir) !== dir ||
        latest?.dev !== before?.dev || latest?.ino !== before?.ino) throw new Error('gateway_status_changed')
      renameSync(temp, path)
      renamed = true
      const parent = openSync(dir, constants.O_RDONLY | constants.O_NOFOLLOW)
      try { fsyncSync(parent) } finally { closeSync(parent) }
    } finally {
      closeSync(fd)
      if (!renamed) {
        try {
          const owned = lstatSync(temp)
          if (owned.dev === temporary.dev && owned.ino === temporary.ino) unlinkSync(temp)
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
      }
    }
  }

  log(message: string): void {
    this.writeStderr(`[gateway-health] ${message}\n`)
    const line = boundUtf8Line(
      `${this.now().toISOString()} ${message}\n`,
      this.maxLogBytes,
    )
    try {
      mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 })
      const currentBytes = existsSync(this.logPath) ? statSync(this.logPath).size : 0
      if (
        currentBytes > 0 &&
        currentBytes + Buffer.byteLength(line, 'utf8') > this.maxLogBytes
      ) {
        rmSync(this.backupPath, { force: true })
        renameSync(this.logPath, this.backupPath)
      }
      appendFileSync(this.logPath, line, { encoding: 'utf8', mode: 0o600 })
      chmodSync(this.logPath, 0o600)
      this.logWriteDegraded = false
    } catch (error) {
      if (this.logWriteDegraded) return
      this.logWriteDegraded = true
      this.writeStderr(
        `[gateway-health] lifecycle file logging degraded: ${formatError(error)}\n`,
      )
    }
  }

  appendDeadLetter(entry: GatewayAlertDeadLetter): void {
    mkdirSync(this.options.stateDir, { recursive: true, mode: 0o700 })
    const line = JSON.stringify({
      at: this.now().toISOString(),
      ...entry,
    }) + '\n'
    appendFileSync(this.deadLetterPath, line, {
      encoding: 'utf8',
      mode: 0o600,
    })
    chmodSync(this.deadLetterPath, 0o600)
  }

  private writeStderr(line: string): void {
    try {
      this.stderr(line)
    } catch {
      // The lifecycle evidence file is still useful when fd 2 is unavailable.
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function boundUtf8Line(line: string, maxBytes: number): string {
  if (maxBytes <= 0) return ''
  const encoded = Buffer.from(line, 'utf8')
  if (encoded.byteLength <= maxBytes) return line
  if (maxBytes === 1) return '\n'

  const content = encoded
    .subarray(0, maxBytes - 1)
    .toString('utf8')
    .replace(/\uFFFD$/u, '')
  return `${content}\n`
}
