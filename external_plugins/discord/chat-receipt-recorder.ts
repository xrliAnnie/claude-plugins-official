import {
  chatDeliveryId,
  normalizeChatDeliveryEnvelope,
  normalizeChatDeliveryAttachments,
  normalizeChatDeliveryReplyTo,
  normalizeChatDeliveryReplyRoute,
} from './shared-chat-delivery-envelope'
import { assertUtcIsoTimestamp } from './shared-discord-utc-timestamp'

export type RecorderMode =
  | {
      kind: 'enabled'
      commCli: string
      dbPath: string
      leadId: string
    }
  | {
      kind: 'disabled'
      reason: 'stock' | 'isolated'
    }
  | {
      kind: 'broken'
      missing: string[]
    }

export interface DeliveryAttachment {
  attachmentId?: string
  name: string
  type: string
  sizeKb: number
  unavailableReason?: 'invalid_metadata' | 'producer_identity_missing'
}

export interface DiscordReplyReference { messageId: string; channelId: string; authorId?: string }

export interface DiscordReplyRoute {
  kind: 'roundtable_thread_from_message'
  parentChannelId: string
  sourceMessageId: string
  threadId: string
  threadName?: string
}

export interface InboundMeta {
  messageId: string
  originChannelId: string
  authorId: string
  authorName: string
  ts: string
  text: string
  attachments: DeliveryAttachment[]
  replyTo?: DiscordReplyReference
}

export interface RoutingMeta {
  leadId: string
  chatId: string
  channelKind: 'dm' | 'guild'
  routedToRoundtable: boolean
  inRoundtableThread: boolean
  replyRoute?: DiscordReplyRoute
}

export interface BeginArgs {
  leadId: string
  chatId: string
  originChannelId: string
  messageId: string
  authorId: string
  authorName: string
  priority: 0 | 1
  ts: string
  msgKind: 'dm' | 'guild' | 'roundtable'
  attachments: DeliveryAttachment[]
  text: string
  replyChannelId?: string
  replyRoute?: DiscordReplyRoute
  replyTo?: DiscordReplyReference
}

export interface SpoolIntentV1 {
  v: 1
  begin: BeginArgs
  attempts: number
  advisedAt: string | null
}

export type RejectedRoutingMeta = Omit<RoutingMeta, 'leadId'>

export interface RejectedIntentV1 {
  v: 1
  kind: 'rejected'
  receivedAt: string
  missing: string[]
  inbound: InboundMeta
  routing: RejectedRoutingMeta
  attempts: number
  nextAttemptAt: string
  advisedAt: string | null
}

const DISCORD_SNOWFLAKE = /^\d{17,20}$/
const INTENT_FILENAME = /^\d{17,20}\.json$/
const CAPABILITY_NAMES = new Set([
  'FLYWHEEL_COMM_CLI',
  'FLYWHEEL_COMM_DB',
  'FLYWHEEL_LEAD_ID',
])
export const REJECTED_REACTION = '⛔'
const STOCK_INBOUND_INSTRUCTION =
  'Messages from Discord arrive as <channel source="discord" chat_id="..." message_id="..." user="..." ts="...">. If the tag has attachment_count, the attachments attribute lists name/type/size — call download_attachment(chat_id, message_id) to fetch them. Reply with the reply tool — pass chat_id back. Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply, omit reply_to for normal responses. If a <channel> tag carries held_since, this Lead\'s mailbox wiring was broken when that message arrived and it was held until now; before acting on held messages, tell the sender in that chat_id how many held messages you just read and when they were sent.'
const STOCK_REPLY_TOOL_DESCRIPTION =
  'Reply on Discord. Pass chat_id from the inbound message. Optionally pass reply_to (message_id) for threading, and files (absolute paths) to attach images or other files.'
const STOCK_REPLY_TO_DESCRIPTION =
  'Message ID to thread under. Use message_id from the inbound <channel> block, or an id from fetch_messages.'

function present(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed ? trimmed : undefined
}

export function resolveRecorderMode(
  env: Record<string, string | undefined>,
): RecorderMode {
  if (
    present(env.FLYWHEEL_LEAD_COMPANION) === '1' ||
    present(env.FLYWHEEL_LEAD_EXTERNAL) === '1'
  ) {
    return { kind: 'disabled', reason: 'isolated' }
  }

  const capability = {
    FLYWHEEL_COMM_CLI: present(env.FLYWHEEL_COMM_CLI),
    FLYWHEEL_COMM_DB: present(env.FLYWHEEL_COMM_DB),
    FLYWHEEL_LEAD_ID: present(env.FLYWHEEL_LEAD_ID),
  }
  if (Object.values(capability).every(value => value === undefined)) {
    return { kind: 'disabled', reason: 'stock' }
  }
  const missing = Object.entries(capability)
    .filter(([, value]) => value === undefined)
    .map(([name]) => name)
  if (missing.length > 0) return { kind: 'broken', missing }

  return {
    kind: 'enabled',
    commCli: capability.FLYWHEEL_COMM_CLI as string,
    dbPath: capability.FLYWHEEL_COMM_DB as string,
    leadId: capability.FLYWHEEL_LEAD_ID as string,
  }
}

function dotenvValue(text: string, key: string): string | undefined {
  let value: string | undefined
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/)
    if (!match || match[1] !== key) continue
    const raw = match[2] ?? ''
    if (
      raw.length >= 2 &&
      ((raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'")))
    ) {
      value = raw.slice(1, -1)
    } else {
      value = raw
    }
  }
  return value
}

function isSnowflake(value: unknown): value is string {
  return typeof value === 'string' && DISCORD_SNOWFLAKE.test(value)
}

export function resolveFounderId(input: {
  env: Record<string, string | undefined>
  envFileText?: string
}): string | undefined {
  const live = dotenvValue(input.envFileText ?? '', 'DISCORD_OWNER_USER_ID')
  if (isSnowflake(live)) return live
  const inherited = present(input.env.DISCORD_OWNER_USER_ID)
  return isSnowflake(inherited) ? inherited : undefined
}

export function resolveFounderIdForMode(
  mode: RecorderMode,
  input: {
    env: Record<string, string | undefined>
    readEnvFile: () => string
  },
): string | undefined {
  if (mode.kind !== 'enabled') return undefined
  let envFileText = ''
  try {
    envFileText = input.readEnvFile()
  } catch {}
  return resolveFounderId({ env: input.env, envFileText })
}

export function buildBeginArgs(
  msg: InboundMeta,
  routing: RoutingMeta,
  founderId?: string,
): BeginArgs {
  const msgKind =
    routing.channelKind === 'dm'
      ? 'dm'
      : routing.routedToRoundtable || routing.inRoundtableThread
        ? 'roundtable'
        : 'guild'
  const envelope = normalizeChatDeliveryEnvelope({
    v: 1,
    deliveryId: chatDeliveryId(routing.leadId, msg.messageId),
    leadId: routing.leadId,
    chatId: msgField(routing.chatId, 'chatId'),
    replyChannelId: msgField(routing.chatId, 'replyChannelId'),
    ...(routing.replyRoute ? { replyRoute: routing.replyRoute } : {}),
    originChannelId: msgField(msg.originChannelId, 'originChannelId'),
    messageId: msgField(msg.messageId, 'messageId'),
    authorId: msgField(msg.authorId, 'authorId'),
    authorName: requiredString(msg.authorName, 'authorName'),
    priority: founderId !== undefined && msg.authorId === founderId ? 0 : 1,
    ts: utcTimestamp(msg.ts, 'ts'),
    msgKind,
    attachments: normalizeAttachments(msg.attachments),
    ...(msg.replyTo === undefined ? {} : { replyTo: normalizeReplyTo(msg.replyTo) }),
    text: stringValue(msg.text, 'text'),
  })
  const { v: _version, deliveryId: _deliveryId, ...begin } = envelope
  return begin
}

export function encodeSpoolIntent(intent: SpoolIntentV1): string {
  return JSON.stringify(normalizeSpoolIntent(intent))
}

export function buildRejectedIntent(
  inbound: InboundMeta,
  routing: RejectedRoutingMeta,
  missing: string[],
  now: Date,
): RejectedIntentV1 {
  const receivedAt = now.toISOString()
  return normalizeRejectedIntent({
    v: 1,
    kind: 'rejected',
    receivedAt,
    missing,
    inbound,
    routing,
    attempts: 0,
    nextAttemptAt: receivedAt,
    advisedAt: null,
  })
}

export function buildRejectedIntentFailClosed(
  inbound: InboundMeta,
  routing: RejectedRoutingMeta,
  missing: string[],
  now: Date,
): { intent: RejectedIntentV1; repairError?: string } {
  try {
    return { intent: buildRejectedIntent(inbound, routing, missing, now) }
  } catch (error) {
    return {
      intent: buildRejectedIntent(
        { ...inbound, attachments: [] },
        routing,
        missing,
        now,
      ),
      repairError: error instanceof Error ? error.message : String(error),
    }
  }
}

export function encodeRejectedIntent(intent: RejectedIntentV1): string {
  return JSON.stringify(normalizeRejectedIntent(intent))
}

export function parseRejectedIntent(encoded: string): RejectedIntentV1 {
  let decoded: unknown
  try {
    decoded = JSON.parse(encoded)
  } catch (error) {
    throw new Error(`Discord rejected intent JSON is invalid: ${(error as Error).message}`)
  }
  return normalizeRejectedIntent(decoded)
}

export function parseSpoolIntent(encoded: string): SpoolIntentV1 {
  let decoded: unknown
  try {
    decoded = JSON.parse(encoded)
  } catch (error) {
    throw new Error(`Discord ingest spool intent JSON is invalid: ${(error as Error).message}`)
  }
  return normalizeSpoolIntent(decoded)
}

export function isIntentFilename(name: string): boolean {
  return INTENT_FILENAME.test(name)
}

export function deliveryInboundInstruction(): string {
  return STOCK_INBOUND_INSTRUCTION
}

export function deliveryReplyToolDescription(): string {
  return STOCK_REPLY_TOOL_DESCRIPTION
}

export function deliveryReplyToDescription(): string {
  return STOCK_REPLY_TO_DESCRIPTION
}

function normalizeSpoolIntent(value: unknown): SpoolIntentV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Discord ingest spool intent must be an object')
  }
  const candidate = value as Record<string, unknown>
  if (candidate.v !== 1) throw new Error('Discord ingest spool intent v1 is required')
  if (!Number.isSafeInteger(candidate.attempts) || (candidate.attempts as number) < 0) {
    throw new Error('Discord ingest spool attempts must be a non-negative integer')
  }
  if (candidate.advisedAt !== null && candidate.advisedAt !== undefined) {
    utcTimestamp(candidate.advisedAt, 'advisedAt')
  }
  return {
    v: 1,
    begin: normalizeBeginArgs(candidate.begin),
    attempts: candidate.attempts as number,
    advisedAt: (candidate.advisedAt as string | null | undefined) ?? null,
  }
}

function normalizeRejectedIntent(value: unknown): RejectedIntentV1 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Discord rejected intent must be an object')
  }
  const candidate = value as Record<string, unknown>
  if (candidate.v !== 1 || candidate.kind !== 'rejected') {
    throw new Error('Discord rejected intent v1 is required')
  }
  if (!Array.isArray(candidate.missing) || candidate.missing.length === 0) {
    throw new Error('Discord rejected intent missing must be a non-empty array')
  }
  const missing = candidate.missing.map((name, index) => {
    const parsed = requiredString(name, `missing[${index}]`)
    if (!CAPABILITY_NAMES.has(parsed)) {
      throw new Error(`missing[${index}] is not a Flywheel capability`)
    }
    return parsed
  })
  if (!Number.isSafeInteger(candidate.attempts) || (candidate.attempts as number) < 0) {
    throw new Error('Discord rejected intent attempts must be a non-negative integer')
  }
  if (candidate.advisedAt !== null && candidate.advisedAt !== undefined) {
    utcTimestamp(candidate.advisedAt, 'advisedAt')
  }
  return {
    v: 1,
    kind: 'rejected',
    receivedAt: utcTimestamp(candidate.receivedAt, 'receivedAt'),
    missing,
    inbound: normalizeInboundMeta(candidate.inbound),
    routing: normalizeRoutingMeta(candidate.routing),
    attempts: candidate.attempts as number,
    nextAttemptAt: utcTimestamp(candidate.nextAttemptAt, 'nextAttemptAt'),
    advisedAt: (candidate.advisedAt as string | null | undefined) ?? null,
  }
}

function normalizeInboundMeta(value: unknown): InboundMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('inbound must be an object')
  }
  const inbound = value as Record<string, unknown>
  return {
    messageId: msgField(inbound.messageId, 'messageId'),
    originChannelId: msgField(inbound.originChannelId, 'originChannelId'),
    authorId: msgField(inbound.authorId, 'authorId'),
    authorName: requiredString(inbound.authorName, 'authorName'),
    ts: utcTimestamp(inbound.ts, 'ts'),
    text: stringValue(inbound.text, 'text'),
    attachments: normalizeAttachments(inbound.attachments),
    ...(inbound.replyTo === undefined ? {} : { replyTo: normalizeReplyTo(inbound.replyTo) }),
  }
}

function normalizeRoutingMeta(value: unknown): RejectedRoutingMeta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('routing must be an object')
  }
  const routing = value as Record<string, unknown>
  if (routing.channelKind !== 'dm' && routing.channelKind !== 'guild') {
    throw new Error('channelKind must be dm or guild')
  }
  if (typeof routing.routedToRoundtable !== 'boolean') {
    throw new Error('routedToRoundtable must be a boolean')
  }
  if (typeof routing.inRoundtableThread !== 'boolean') {
    throw new Error('inRoundtableThread must be a boolean')
  }
  return {
    chatId: msgField(routing.chatId, 'chatId'),
    channelKind: routing.channelKind,
    routedToRoundtable: routing.routedToRoundtable,
    inRoundtableThread: routing.inRoundtableThread,
    ...(routing.replyRoute === undefined
      ? {}
      : { replyRoute: normalizeReplyRoute(routing.replyRoute) }),
  }
}

function normalizeBeginArgs(value: unknown): BeginArgs {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Discord ingest spool begin must be an object')
  }
  const begin = value as Record<string, unknown>
  const priority = begin.priority
  if (priority !== 0 && priority !== 1) {
    throw new Error('Discord ingest spool priority must be 0 or 1')
  }
  const msgKind = begin.msgKind
  if (msgKind !== 'dm' && msgKind !== 'guild' && msgKind !== 'roundtable') {
    throw new Error('Discord ingest spool msgKind must be dm, guild, or roundtable')
  }
  const chatId = msgField(begin.chatId, 'chatId')
  return {
    leadId: requiredString(begin.leadId, 'leadId'),
    chatId,
    replyChannelId:
      begin.replyChannelId === undefined
        ? chatId
        : msgField(begin.replyChannelId, 'replyChannelId'),
    ...(begin.replyRoute === undefined
      ? {}
      : { replyRoute: normalizeReplyRoute(begin.replyRoute) }),
    originChannelId: msgField(begin.originChannelId, 'originChannelId'),
    messageId: msgField(begin.messageId, 'messageId'),
    authorId: msgField(begin.authorId, 'authorId'),
    authorName: requiredString(begin.authorName, 'authorName'),
    priority,
    ts: utcTimestamp(begin.ts, 'ts'),
    msgKind,
    attachments: normalizeAttachments(begin.attachments),
    ...(begin.replyTo === undefined ? {} : { replyTo: normalizeReplyTo(begin.replyTo) }),
    text: stringValue(begin.text, 'text'),
  }
}

function normalizeReplyTo(value: unknown): DiscordReplyReference {
  return normalizeChatDeliveryReplyTo(value)
}

function normalizeReplyRoute(value: unknown): DiscordReplyRoute {
  return normalizeChatDeliveryReplyRoute(value)
}

function normalizeAttachments(value: unknown): DeliveryAttachment[] {
  return normalizeChatDeliveryAttachments(value)
}

function msgField(value: unknown, field: string): string {
  if (!isSnowflake(value)) throw new Error(`${field} must be a Discord snowflake`)
  return value
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`${field} must be a string`)
  return value
}

function utcTimestamp(value: unknown, field: string): string {
  const parsed = requiredString(value, field)
  assertUtcIsoTimestamp(parsed, field)
  return parsed
}
