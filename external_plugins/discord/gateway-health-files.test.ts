import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayHealthFiles } from './gateway-health-files'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('GatewayHealthFiles', () => {
  it('writes lifecycle evidence to stderr and keeps one bounded rotated backup', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fly2226-gateway-log-'))
    tempDirs.push(stateDir)
    const stderr: string[] = []
    const files = new GatewayHealthFiles({
      stateDir,
      maxLogBytes: 120,
      now: () => new Date('2026-09-01T09:00:00.000Z'),
      stderr: line => { stderr.push(line) },
    })

    files.log(`first ${'a'.repeat(70)}`)
    files.log(`second ${'b'.repeat(70)}`)

    expect(readFileSync(join(stateDir, 'gateway-health.log.1'), 'utf8')).toContain('first')
    expect(readFileSync(join(stateDir, 'gateway-health.log'), 'utf8')).toContain('second')
    expect(stderr.join('')).toContain('first')
    expect(stderr.join('')).toContain('second')
  })
})
