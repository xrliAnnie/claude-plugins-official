import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs'
import { join } from 'node:path'
import type { GatewayAlertDeadLetter } from './gateway-alert'

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
