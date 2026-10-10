import { afterEach, describe, expect, it } from 'bun:test'
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GatewayHealthFiles } from './gateway-health-files'
import { GatewayStatusTelemetry } from './gateway-status'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('GatewayHealthFiles', () => {
  it('atomically publishes bounded private current-instance status without following a leaf symlink', () => {
    const stateDir = realpathSync(mkdtempSync(join(tmpdir(), 'fly3433-gateway-status-')))
    tempDirs.push(stateDir)
    const files = new GatewayHealthFiles({ stateDir, stderr: () => {} })
    const status = new GatewayStatusTelemetry({
      project: 'fixture', lead: 'eng-lead', identityDigest: 'a'.repeat(64),
      launchGeneration: 'launch-one', leaseGeneration: 7,
      serverPid: 200, serverStart: 'server-start', parentPid: 100, parentStart: 'parent-start',
      botUserId: '22345678901234567',
    }, () => 100_000)
    files.writeStatus(status.snapshot())
    const path = join(stateDir, 'gateway-status.json')
    expect(JSON.parse(readFileSync(path, 'utf8')).serverPid).toBe(200)
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(() => files.writeStatus({ ...status.snapshot(), project: 'x'.repeat(65_536) })).toThrow('gateway_status_size')
    rmSync(path)
    const target = join(stateDir, 'source')
    writeFileSync(target, 'unchanged')
    symlinkSync(target, path)
    expect(() => files.writeStatus(status.snapshot())).toThrow('gateway_status_unsafe')
    expect(readFileSync(target, 'utf8')).toBe('unchanged')
  })
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

  it('bounds a single oversized lifecycle entry instead of growing past the log cap', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fly2226-gateway-log-'))
    tempDirs.push(stateDir)
    const files = new GatewayHealthFiles({
      stateDir,
      maxLogBytes: 120,
      now: () => new Date('2026-09-01T09:00:00.000Z'),
      stderr: () => {},
    })

    files.log(`oversized ${'x'.repeat(500)}`)

    expect(statSync(join(stateDir, 'gateway-health.log')).size).toBeLessThanOrEqual(120)
    expect(readFileSync(join(stateDir, 'gateway-health.log'), 'utf8')).toContain(
      'oversized',
    )
  })

  it('reports lifecycle file degradation once without throwing from the event loop', () => {
    const statePath = join(
      mkdtempSync(join(tmpdir(), 'fly2226-gateway-log-')),
      'not-a-directory',
    )
    tempDirs.push(statePath.slice(0, statePath.lastIndexOf('/')))
    writeFileSync(statePath, 'occupied')
    const stderr: string[] = []
    const files = new GatewayHealthFiles({
      stateDir: statePath,
      stderr: line => { stderr.push(line) },
    })

    expect(() => files.log('first')).not.toThrow()
    expect(() => files.log('second')).not.toThrow()

    expect(stderr.filter(line => line.includes('logging degraded'))).toHaveLength(1)
  })

  it('continues durable logging when the stderr sink itself throws', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fly2226-gateway-log-'))
    tempDirs.push(stateDir)
    const files = new GatewayHealthFiles({
      stateDir,
      stderr: () => { throw new Error('stderr closed') },
    })

    expect(() => files.log('still durable')).not.toThrow()
    expect(readFileSync(join(stateDir, 'gateway-health.log'), 'utf8')).toContain(
      'still durable',
    )
  })

  it('writes alert delivery failures as private JSONL dead letters', () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'fly2226-gateway-log-'))
    tempDirs.push(stateDir)
    const files = new GatewayHealthFiles({
      stateDir,
      now: () => new Date('2026-09-01T09:00:00.000Z'),
      stderr: () => {},
    })

    files.appendDeadLetter({
      episodeKey: 'gateway-recovery-1',
      body: 'forced reconnect failed',
      error: 'Discord REST 503',
    })

    const path = join(stateDir, 'gateway-health-dead-letter.jsonl')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
      at: '2026-09-01T09:00:00.000Z',
      episodeKey: 'gateway-recovery-1',
      body: 'forced reconnect failed',
      error: 'Discord REST 503',
    })
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })
})
