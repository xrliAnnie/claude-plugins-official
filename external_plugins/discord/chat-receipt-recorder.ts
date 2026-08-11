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
  name: string
  type: string
  sizeKb: number
}

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
}

export interface SpoolIntentV1 {
  v: 1
  begin: BeginArgs
  attempts: number
  advisedAt: string | null
}

const DISCORD_SNOWFLAKE = /^\d{17,20}$/
const INTENT_FILENAME = /^\d{17,20}\.json$/
const STOCK_INBOUND_INSTRUCTION =
  'Messages from Discord arrive as <channel source="discord" chat_id="..." message_id="..." user="..." ts="...">. If the tag has attachment_count, the attachments attribute lists name/type/size — call download_attachment(chat_id, message_id) to fetch them. Reply with the reply tool — pass chat_id back. Use reply_to (set to a message_id) only when replying to an earlier message; the latest message doesn\'t need a quote-reply, omit reply_to for normal responses.'
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
  return {
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
    text: stringValue(msg.text, 'text'),
  }
}

export function encodeSpoolIntent(intent: SpoolIntentV1): string {
  return JSON.stringify(normalizeSpoolIntent(intent))
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
    text: stringValue(begin.text, 'text'),
  }
}

function normalizeReplyRoute(value: unknown): DiscordReplyRoute {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('replyRoute must be an object')
  }
  const route = value as Record<string, unknown>
  if (route.kind !== 'roundtable_thread_from_message') {
    throw new Error('replyRoute.kind is invalid')
  }
  return {
    kind: route.kind,
    parentChannelId: msgField(route.parentChannelId, 'replyRoute.parentChannelId'),
    sourceMessageId: msgField(route.sourceMessageId, 'replyRoute.sourceMessageId'),
    threadId: msgField(route.threadId, 'replyRoute.threadId'),
    ...(route.threadName === undefined
      ? {}
      : { threadName: requiredString(route.threadName, 'replyRoute.threadName') }),
  }
}

function normalizeAttachments(value: unknown): DeliveryAttachment[] {
  if (!Array.isArray(value)) throw new Error('attachments must be an array')
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`attachments[${index}] must be an object`)
    }
    const attachment = entry as Record<string, unknown>
    if (
      typeof attachment.sizeKb !== 'number' ||
      !Number.isFinite(attachment.sizeKb) ||
      attachment.sizeKb < 0
    ) {
      throw new Error(`attachments[${index}].sizeKb must be non-negative`)
    }
    return {
      name: requiredString(attachment.name, `attachments[${index}].name`),
      type: requiredString(attachment.type, `attachments[${index}].type`),
      sizeKb: attachment.sizeKb,
    }
  })
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
  if (!parsed.endsWith('Z') || Number.isNaN(Date.parse(parsed))) {
    throw new Error(`${field} must be a UTC ISO timestamp`)
  }
  return parsed
}
