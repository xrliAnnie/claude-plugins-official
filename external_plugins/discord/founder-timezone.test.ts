import { describe, expect, test } from 'bun:test'
import {
  buildInboundMeta,
  createFounderTimezoneResolver,
  formatFounderLocal,
  formatHistoryRow,
} from './founder-timezone'

function resolverIo(
  overrides: Partial<Parameters<typeof createFounderTimezoneResolver>[0]> = {},
) {
  return {
    env: {} as Record<string, string | undefined>,
    readlinkSync: () => '/var/db/timezone/zoneinfo/America/Los_Angeles',
    nowMs: () => 0,
    intlTimezone: () => 'America/Los_Angeles',
    warn: (_message: string) => {},
    ...overrides,
  }
}

describe('founder timezone resolver', () => {
  test('prefers a live env override and falls back from an invalid override', () => {
    const env: Record<string, string | undefined> = { FLYWHEEL_FOUNDER_TZ: 'Asia/Tokyo' }
    const warnings: string[] = []
    const resolver = createFounderTimezoneResolver(resolverIo({ env, warn: message => warnings.push(message) }))

    expect(resolver.resolveFounderTimezone()).toBe('Asia/Tokyo')
    env.FLYWHEEL_FOUNDER_TZ = 'Not/AZone'
    expect(resolver.resolveFounderTimezone()).toBe('America/Los_Angeles')
    expect(warnings).toHaveLength(1)
  })

  test.each([
    ['/var/db/timezone/zoneinfo/America/Los_Angeles', 'America/Los_Angeles'],
    ['/usr/share/zoneinfo/Europe/Berlin', 'Europe/Berlin'],
    ['../usr/share/zoneinfo/Asia/Tokyo', 'Asia/Tokyo'],
  ])('reads macOS, Linux, and relative localtime links', (link, expected) => {
    const resolver = createFounderTimezoneResolver(resolverIo({ readlinkSync: () => link }))
    expect(resolver.resolveFounderTimezone()).toBe(expected)
  })

  test('uses Intl when /etc/localtime cannot be read', () => {
    const resolver = createFounderTimezoneResolver(
      resolverIo({
        readlinkSync: () => {
          throw new Error('copy-style localtime')
        },
        intlTimezone: () => 'Asia/Tokyo',
      }),
    )
    expect(resolver.resolveFounderTimezone()).toBe('Asia/Tokyo')
  })

  test('uses Los Angeles only after host and Intl candidates are invalid', () => {
    const resolver = createFounderTimezoneResolver(
      resolverIo({
        readlinkSync: () => '/tmp/not-zoneinfo/Not/AZone',
        intlTimezone: () => 'Also/Invalid',
      }),
    )
    expect(resolver.resolveFounderTimezone()).toBe('America/Los_Angeles')
  })

  test('refreshes the host link after the 60-second TTL', () => {
    let now = 0
    let link = '/usr/share/zoneinfo/Asia/Tokyo'
    let probes = 0
    const resolver = createFounderTimezoneResolver(
      resolverIo({
        nowMs: () => now,
        readlinkSync: () => {
          probes += 1
          return link
        },
      }),
    )

    expect(resolver.resolveFounderTimezone()).toBe('Asia/Tokyo')
    link = '/usr/share/zoneinfo/Europe/Paris'
    now = 59_999
    expect(resolver.resolveFounderTimezone()).toBe('Asia/Tokyo')
    now = 60_000
    expect(resolver.resolveFounderTimezone()).toBe('Europe/Paris')
    expect(probes).toBe(2)
  })
})

describe('founder-local Discord metadata', () => {
  const sentAt = new Date('2026-07-17T02:23:05.000Z')

  test('adds founder_local while preserving the UTC ts byte-for-byte', () => {
    const base = {
      chat_id: 'chat-1',
      message_id: 'message-1',
      user: 'annie',
      user_id: 'founder-1',
      ts: '2026-07-17T02:23:05.000Z',
    }

    const meta = buildInboundMeta(base, sentAt, 'America/Los_Angeles')

    expect(meta.ts).toBe('2026-07-17T02:23:05.000Z')
    expect(meta.founder_local).toBe('2026-07-16 19:23 PDT')
    expect(base).not.toHaveProperty('founder_local')
  })

  test('formats history with both UTC and current founder-wall-clock semantics', () => {
    expect(
      formatHistoryRow(
        {
          createdAt: sentAt,
          who: 'annie',
          text: 'still today here',
          messageId: 'message-1',
          attachmentsSuffix: '',
        },
        'America/Los_Angeles',
      ),
    ).toBe(
      '[2026-07-17T02:23:05.000Z | founder_local=2026-07-16 19:23 PDT (message instant rendered in the currently resolved founder timezone)] annie: still today here  (id: message-1)',
    )
  })

  test('formats DST using the resolved timezone', () => {
    expect(formatFounderLocal(new Date('2026-03-08T09:59:00.000Z'), 'America/Los_Angeles')).toEndWith('PST')
    expect(formatFounderLocal(new Date('2026-03-08T10:01:00.000Z'), 'America/Los_Angeles')).toEndWith('PDT')
  })
})
