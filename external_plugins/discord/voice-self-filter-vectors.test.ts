import { expect, it } from 'bun:test'
import {
  voiceSelfFilterRequestAuth,
  voiceSelfFilterResponseAuth,
} from './voice-self-filter-socket'

const secret = 'fly2711-golden-vector-not-a-token'
const leadId = 'fly2711-vector-lead'
const expectedBotUserId = '100000000000000005'
const nonce = '0123456789abcdef'.repeat(4)
const runtimeId = '11111111-2222-4333-8444-555555555555'

it('matches the main repository voice self-filter MAC vectors', () => {
  expect(voiceSelfFilterRequestAuth({
    leadId,
    expectedBotUserId,
    nonce,
  }, secret)).toBe(
    'd20dee69e6458bbf92cf9e78db928b861e4be659d2af568ffd01c2a46f85ca68',
  )
  expect(voiceSelfFilterResponseAuth({
    version: 1,
    leadId,
    botUserId: expectedBotUserId,
    runtimeId,
    nonce,
    ready: true,
    selfDropped: true,
    unknownDropped: true,
    otherPassed: true,
  }, secret)).toBe(
    'acd7faf5ecb785834d36ffc2a423df4c63a6fe52cd96e72f16422f755c4ae581',
  )
})
