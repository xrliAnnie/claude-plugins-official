import type { GatewayHealthFailure } from './gateway-health'

const SNOWFLAKE_RE = /^\d{15,21}$/
const INVALID_ALERT_CHANNEL = 'DISCORD_ALERT_CHANNEL is missing or invalid'

export function gatewayAlertConfigurationError(
  alertChannelId: string | undefined,
): string | undefined {
  return isGatewayAlertChannelId(alertChannelId)
    ? undefined
    : INVALID_ALERT_CHANNEL
}

export interface GatewayFailureAlerterOptions {
  alertChannelId: string | undefined
  sendDiscord(channelId: string, content: string): Promise<void>
  appendDeadLetter(entry: GatewayAlertDeadLetter): void
  log(message: string): void
}

export interface GatewayAlertDeadLetter {
  episodeKey: string
  body: string
  error: string
}

export class GatewayFailureAlerter {
  private readonly handledEpisodes = new Set<string>()
  private readonly inFlightEpisodes = new Map<string, Promise<void>>()

  constructor(private readonly options: GatewayFailureAlerterOptions) {}

  alert(failure: GatewayHealthFailure): Promise<void> {
    if (this.handledEpisodes.has(failure.episodeKey)) return Promise.resolve()
    const active = this.inFlightEpisodes.get(failure.episodeKey)
    if (active) return active

    const delivery = this.deliver(failure).finally(() => {
      this.inFlightEpisodes.delete(failure.episodeKey)
    })
    this.inFlightEpisodes.set(failure.episodeKey, delivery)
    return delivery
  }

  private async deliver(failure: GatewayHealthFailure): Promise<void> {
    const channelId = this.options.alertChannelId
    const configurationError = gatewayAlertConfigurationError(channelId)
    if (configurationError || !isGatewayAlertChannelId(channelId)) {
      this.deadLetter(failure, configurationError ?? INVALID_ALERT_CHANNEL)
      return
    }
    const content =
      '🚨 Discord gateway self-heal failed\n' +
      `episode: ${failure.episodeKey}\n` +
      failure.body
    try {
      await this.options.sendDiscord(channelId, content)
      this.handledEpisodes.add(failure.episodeKey)
    } catch (error) {
      this.deadLetter(failure, formatError(error))
    }
  }

  private deadLetter(failure: GatewayHealthFailure, error: string): void {
    try {
      this.options.appendDeadLetter({
        episodeKey: failure.episodeKey,
        body: failure.body,
        error,
      })
      this.handledEpisodes.add(failure.episodeKey)
    } catch (deadLetterError) {
      this.options.log(
        `gateway alert dead-letter write failed: ${formatError(deadLetterError)}`,
      )
    }
  }
}

function isGatewayAlertChannelId(
  alertChannelId: string | undefined,
): alertChannelId is string {
  return !!alertChannelId && SNOWFLAKE_RE.test(alertChannelId)
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
