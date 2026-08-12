export class DiscordIdentityAssertionError extends Error {
  constructor(
    readonly code:
      | 'identity_expected_bot_user_id_missing'
      | 'identity_authenticated_bot_user_id_missing'
      | 'identity_bot_user_id_mismatch',
    message: string,
  ) {
    super(`${code}: ${message}`)
    this.name = 'DiscordIdentityAssertionError'
  }
}

export async function authenticateDiscordIdentity(input: {
  managed: boolean
  expectedUserId: string | undefined
  login: () => Promise<unknown>
  actualUserId: () => string | undefined
  registerInboundHandlers: () => void | Promise<void>
}): Promise<string | undefined> {
  const expected = input.expectedUserId?.trim()
  if (input.managed && !expected) {
    throw new DiscordIdentityAssertionError(
      'identity_expected_bot_user_id_missing',
      'DISCORD_EXPECTED_BOT_USER_ID is required before Discord login',
    )
  }
  await input.login()

  // The plugin is installed machine-wide and also starts for ordinary Claude
  // sessions. Only managed Lead adapters carry the canonical identity tuple;
  // preserve the legacy unmanaged path when no assertion was requested.
  if (!expected) {
    await input.registerInboundHandlers()
    return input.actualUserId()?.trim()
  }

  const actual = input.actualUserId()?.trim()
  if (!actual) {
    throw new DiscordIdentityAssertionError(
      'identity_authenticated_bot_user_id_missing',
      'Discord login completed without an authenticated bot user id',
    )
  }
  if (actual !== expected) {
    throw new DiscordIdentityAssertionError(
      'identity_bot_user_id_mismatch',
      `authenticated bot ${actual} does not match canonical bot ${expected}`,
    )
  }
  await input.registerInboundHandlers()
  return actual
}
