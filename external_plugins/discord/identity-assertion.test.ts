import { describe, expect, it } from 'bun:test'
import { authenticateDiscordIdentity } from './identity-assertion'

describe('authenticateDiscordIdentity', () => {
  it('rejects a missing expected id without login or handler registration', async () => {
    let loginCalls = 0
    let registerCalls = 0
    await expect(
      authenticateDiscordIdentity({
        expectedUserId: undefined,
        login: async () => {
          loginCalls += 1
        },
        actualUserId: () => '11111111111111111',
        registerInboundHandlers: () => {
          registerCalls += 1
        },
      }),
    ).rejects.toThrow('identity_expected_bot_user_id_missing')
    expect(loginCalls).toBe(0)
    expect(registerCalls).toBe(0)
  })

  it('allows only the login handshake before rejecting a mismatched bot', async () => {
    let loginCalls = 0
    let registerCalls = 0
    await expect(
      authenticateDiscordIdentity({
        expectedUserId: '11111111111111111',
        login: async () => {
          loginCalls += 1
        },
        actualUserId: () => '22222222222222222',
        registerInboundHandlers: () => {
          registerCalls += 1
        },
      }),
    ).rejects.toThrow('identity_bot_user_id_mismatch')
    expect(loginCalls).toBe(1)
    expect(registerCalls).toBe(0)
  })

  it('registers inbound handlers only after the authenticated id matches', async () => {
    const order: string[] = []
    const actual = await authenticateDiscordIdentity({
      expectedUserId: '11111111111111111',
      login: async () => {
        order.push('login')
      },
      actualUserId: () => {
        order.push('read-user')
        return '11111111111111111'
      },
      registerInboundHandlers: () => {
        order.push('register')
      },
    })
    expect(actual).toBe('11111111111111111')
    expect(order).toEqual(['login', 'read-user', 'register'])
  })
})
