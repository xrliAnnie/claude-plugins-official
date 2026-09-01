import { describe, expect, it } from 'bun:test'
import {
  GatewayFailureAlerter,
  gatewayAlertConfigurationError,
} from './gateway-alert'

describe('GatewayFailureAlerter', () => {
  it('reports invalid alert-channel configuration before the first failure', () => {
    expect(gatewayAlertConfigurationError(undefined)).toBe(
      'DISCORD_ALERT_CHANNEL is missing or invalid',
    )
    expect(gatewayAlertConfigurationError('not-a-snowflake')).toBe(
      'DISCORD_ALERT_CHANNEL is missing or invalid',
    )
    expect(gatewayAlertConfigurationError('100000000000000001')).toBeUndefined()
  })

  it('sends one immutable alert through the plugin REST path without dead-lettering', async () => {
    const sent: Array<{ channelId: string; content: string }> = []
    const deadLetters: unknown[] = []
    const alerter = new GatewayFailureAlerter({
      alertChannelId: '100000000000000001',
      sendDiscord: async (channelId, content) => { sent.push({ channelId, content }) },
      appendDeadLetter: entry => { deadLetters.push(entry) },
      log: () => {},
    })
    const failure = {
      episodeKey: 'gateway-recovery-1',
      body: 'Discord gateway forced reconnect did not recover',
    }

    await alerter.alert(failure)
    await alerter.alert(failure)

    expect(sent).toEqual([{
      channelId: '100000000000000001',
      content:
        '🚨 Discord gateway self-heal failed\n' +
        'episode: gateway-recovery-1\n' +
        'Discord gateway forced reconnect did not recover',
    }])
    expect(deadLetters).toEqual([])
  })

  it('does not guess a channel and dead-letters missing or invalid alert configuration', async () => {
    const sent: string[] = []
    const deadLetters: Array<{ episodeKey: string; error: string }> = []

    for (const [index, alertChannelId] of [undefined, 'not-a-snowflake'].entries()) {
      const alerter = new GatewayFailureAlerter({
        alertChannelId,
        sendDiscord: async channelId => { sent.push(channelId) },
        appendDeadLetter: entry => {
          deadLetters.push({ episodeKey: entry.episodeKey, error: entry.error })
        },
        log: () => {},
      })
      await alerter.alert({
        episodeKey: `gateway-config-${index}`,
        body: 'startup compatibility guard failed',
      })
    }

    expect(sent).toEqual([])
    expect(deadLetters).toEqual([
      {
        episodeKey: 'gateway-config-0',
        error: 'DISCORD_ALERT_CHANNEL is missing or invalid',
      },
      {
        episodeKey: 'gateway-config-1',
        error: 'DISCORD_ALERT_CHANNEL is missing or invalid',
      },
    ])
  })

  it('dead-letters a REST failure without throwing or retrying the episode', async () => {
    let sendCalls = 0
    const deadLetters: Array<{ episodeKey: string; body: string; error: string }> = []
    const alerter = new GatewayFailureAlerter({
      alertChannelId: '100000000000000001',
      sendDiscord: async () => {
        sendCalls += 1
        throw new Error('Discord REST 503')
      },
      appendDeadLetter: entry => { deadLetters.push(entry) },
      log: () => {},
    })
    const failure = {
      episodeKey: 'gateway-recovery-2',
      body: 'raw shard destroy rejected',
    }

    await expect(alerter.alert(failure)).resolves.toBeUndefined()
    await expect(alerter.alert(failure)).resolves.toBeUndefined()

    expect(sendCalls).toBe(1)
    expect(deadLetters).toEqual([{
      episodeKey: 'gateway-recovery-2',
      body: 'raw shard destroy rejected',
      error: 'Discord REST 503',
    }])
  })
})
