import { readlinkSync as nodeReadlinkSync } from 'node:fs'

const DEFAULT_FOUNDER_TIMEZONE = 'America/Los_Angeles'
const HOST_TIMEZONE_TTL_MS = 60_000

export interface FounderTimezoneResolverIo {
  env: Record<string, string | undefined>
  readlinkSync: (path: string) => string
  nowMs: () => number
  intlTimezone: () => string | undefined
  warn: (message: string) => void
}

function isValidTimezone(timezone: string | undefined): timezone is string {
  if (!timezone) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format()
    return true
  } catch {
    return false
  }
}

function timezoneFromLocaltimeLink(link: string): string | undefined {
  const marker = '/zoneinfo/'
  const markerIndex = link.lastIndexOf(marker)
  if (markerIndex < 0) return undefined
  return link.slice(markerIndex + marker.length) || undefined
}

export function createFounderTimezoneResolver(io: FounderTimezoneResolverIo) {
  let hostTimezone: string | undefined
  let hostProbedAt = Number.NEGATIVE_INFINITY
  let warnedInvalidEnv = false

  function probeHostTimezone(now: number): string | undefined {
    if (now - hostProbedAt < HOST_TIMEZONE_TTL_MS) return hostTimezone
    hostProbedAt = now
    try {
      const candidate = timezoneFromLocaltimeLink(io.readlinkSync('/etc/localtime'))
      hostTimezone = isValidTimezone(candidate) ? candidate : undefined
    } catch {
      hostTimezone = undefined
    }
    return hostTimezone
  }

  return {
    resolveFounderTimezone(): string {
      const envTimezone = io.env.FLYWHEEL_FOUNDER_TZ?.trim()
      if (envTimezone) {
        if (isValidTimezone(envTimezone)) return envTimezone
        if (!warnedInvalidEnv) {
          warnedInvalidEnv = true
          io.warn(`Ignoring invalid FLYWHEEL_FOUNDER_TZ=${JSON.stringify(envTimezone)}`)
        }
      }

      const host = probeHostTimezone(io.nowMs())
      if (host) return host

      const intl = io.intlTimezone()
      if (isValidTimezone(intl)) return intl

      return DEFAULT_FOUNDER_TIMEZONE
    },
  }
}

const defaultResolver = createFounderTimezoneResolver({
  env: process.env,
  readlinkSync: path => nodeReadlinkSync(path, 'utf8'),
  nowMs: Date.now,
  intlTimezone: () => Intl.DateTimeFormat().resolvedOptions().timeZone,
  warn: message => process.stderr.write(`discord channel: founder timezone: ${message}\n`),
})

export function resolveFounderTimezone(): string {
  return defaultResolver.resolveFounderTimezone()
}

function founderLocalParts(date: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    calendar: 'iso8601',
    numberingSystem: 'latn',
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    timeZoneName: 'short',
  }).formatToParts(date)
  const value = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find(part => part.type === type)?.value ?? ''
  return {
    year: value('year'),
    month: value('month'),
    day: value('day'),
    hour: value('hour'),
    minute: value('minute'),
    timeZoneName: value('timeZoneName'),
  }
}

export function formatFounderLocal(date: Date, timezone = resolveFounderTimezone()): string {
  const parts = founderLocalParts(date, timezone)
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute} ${parts.timeZoneName}`
}

export function buildInboundMeta<T extends Record<string, string>>(
  base: T,
  sentAt: Date,
  timezone = resolveFounderTimezone(),
): T & { founder_local: string } {
  return { ...base, founder_local: formatFounderLocal(sentAt, timezone) }
}

export interface HistoryRow {
  createdAt: Date
  who: string
  text: string
  messageId: string
  attachmentsSuffix: string
}

export function formatHistoryRow(row: HistoryRow, timezone = resolveFounderTimezone()): string {
  const founderLocal = formatFounderLocal(row.createdAt, timezone)
  return `[${row.createdAt.toISOString()} | founder_local=${founderLocal} (message instant rendered in the currently resolved founder timezone)] ${row.who}: ${row.text}  (id: ${row.messageId}${row.attachmentsSuffix})`
}
