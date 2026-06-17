/**
 * FLY-309 — REAL Discord E2E for the FLY-306 reply retry guard.
 * Slot 1 ONLY: test bot flywheel-test-1 + #cos-test channel. Never production.
 *
 * Drives the EXACT shipping reply path: imports the #6 `sendReplyChunks` and
 * builds the retry opts exactly the way server.ts does (env → parseIntInRange).
 * A real discord.js client (logged in as the test bot) actually delivers to the
 * real channel; failures for ③/④ are injected by wrapping the real `ch.send`
 * (the throw happens BEFORE any real send, so an injected failure creates NO
 * real message). Verification fetches the channel back and counts real messages
 * by a per-run nonce — proving delivery AND no duplicates.
 *
 * QA-only: does not modify the implementation.
 */
import { Client, GatewayIntentBits, type TextChannel } from 'discord.js'
import { RateLimitError } from '@discordjs/rest'
import { sendReplyChunks, type SendPayload, type ReplyChunkOpts } from './reply-send'
import { parseIntInRange, type SendWithRetryOpts } from './retry'

const TOKEN = process.env.TEST_BOT_TOKEN_1
const CHANNEL_ID = '1493080991290626079' // #cos-test (slot 1)
const GUILD_ID = '1485787271192907816'
if (!TOKEN) {
  console.error('FATAL: TEST_BOT_TOKEN_1 not set'); process.exit(2)
}

// Per-run nonce so we only count THIS run's messages.
const RUN = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`
const mark = (label: string) => `FLY-309 E2E [${RUN}] ${label}`

// ── Faithful copy of server.ts's reply-retry wiring (lines ~281-307) ──────────
const envInt = (name: string, fb: number, min: number, max: number): number =>
  parseIntInRange(process.env[name], fb, min, max)
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))
function buildReplyRetryOpts(): SendWithRetryOpts {
  return {
    maxRetries: envInt('DISCORD_REPLY_MAX_RETRIES', 3, 0, 10),
    baseMs: envInt('DISCORD_REPLY_RETRY_BASE_MS', 500, 0, 60_000),
    capMs: envInt('DISCORD_REPLY_RETRY_CAP_MS', 8_000, 0, 120_000),
    sleep,
    jitterRand: Math.random,
    onRetry: ({ attempt, delayMs, err }) => {
      const m = err instanceof Error ? err.message : String(err)
      process.stderr.write(`  [retry] attempt ${attempt + 1}, in ${delayMs}ms: ${m}\n`)
    },
  }
}
const CHUNK_OPTS: ReplyChunkOpts = { files: [], reply_to: undefined, replyMode: 'first' }

function realRateLimitError(): RateLimitError {
  return new RateLimitError({
    timeToReset: 300, limit: 5, method: 'POST', hash: 'h',
    url: 'https://discord.com/api/v10/channels/1/messages',
    route: '/channels/:id/messages', majorParameter: '1',
    global: false, retryAfter: 300, sublimitTimeout: 0, scope: 'user',
  } as ConstructorParameters<typeof RateLimitError>[0])
}

type Result = { name: string; pass: boolean; detail: string }
const results: Result[] = []
function record(name: string, pass: boolean, detail: string) {
  results.push({ name, pass, detail })
  console.log(`${pass ? '✅ PASS' : '❌ FAIL'}  ${name}\n   ${detail}`)
}

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] })
  const ready = new Promise<void>((res, rej) => {
    client.once('ready', () => res())
    setTimeout(() => rej(new Error('login timeout (15s)')), 15_000)
  })
  await client.login(TOKEN)
  await ready
  console.log(`logged in as ${client.user?.tag} (id ${client.user?.id}); run nonce=${RUN}`)

  const ch = (await client.channels.fetch(CHANNEL_ID)) as TextChannel | null
  if (!ch || !('send' in ch)) {
    console.error(`FATAL: channel ${CHANNEL_ID} not fetchable/sendable (bot in guild ${GUILD_ID}?)`)
    await client.destroy(); process.exit(2)
  }
  if (ch.guildId !== GUILD_ID) {
    console.error(`FATAL: channel guild ${ch.guildId} != expected ${GUILD_ID} — refusing (slot safety)`)
    await client.destroy(); process.exit(2)
  }
  const realSend = (p: SendPayload) => ch.send(p as any) as Promise<{ id: string }>

  // Count real messages in the channel (REST fetch) by this bot containing `needle`.
  async function countInChannel(needle: string): Promise<{ count: number; ids: string[] }> {
    const msgs = await ch.messages.fetch({ limit: 50 })
    const mine = [...msgs.values()].filter(
      m => m.author.id === client.user?.id && m.content.includes(needle),
    )
    return { count: mine.length, ids: mine.map(m => m.id) }
  }

  // ── ① normal reply truly delivered ──────────────────────────────────────────
  try {
    const needle = mark('① normal-send')
    const ids = await sendReplyChunks(realSend, [needle], CHUNK_OPTS, buildReplyRetryOpts())
    const seen = await countInChannel(needle)
    record(
      '① normal reply delivered',
      ids.length === 1 && seen.count === 1 && seen.ids[0] === ids[0],
      `returned id=${ids[0]}; channel has ${seen.count} msg w/ nonce (ids=${seen.ids.join(',')})`,
    )
  } catch (e) { record('① normal reply delivered', false, `threw: ${(e as Error).message}`) }

  // ── ② kill-switch DISCORD_REPLY_MAX_RETRIES=0 still sends ────────────────────
  try {
    process.env.DISCORD_REPLY_MAX_RETRIES = '0'
    const opts0 = buildReplyRetryOpts()
    const needle = mark('② kill-switch maxRetries=0')
    const ids = await sendReplyChunks(realSend, [needle], CHUNK_OPTS, opts0)
    const seen = await countInChannel(needle)
    record(
      '② kill-switch (=0) still delivers',
      opts0.maxRetries === 0 && ids.length === 1 && seen.count === 1,
      `env parsed maxRetries=${opts0.maxRetries}; returned id=${ids[0]}; channel count=${seen.count}`,
    )
    delete process.env.DISCORD_REPLY_MAX_RETRIES
  } catch (e) { record('② kill-switch (=0) still delivers', false, `threw: ${(e as Error).message}`) }

  // ② extra: with =0 an injected transient FAILS fast (proves it reverts retry) — no real msg
  try {
    process.env.DISCORD_REPLY_MAX_RETRIES = '0'
    const opts0 = buildReplyRetryOpts()
    const needle = mark('② kill-switch no-retry')
    let calls = 0
    const inject = async (p: SendPayload) => { calls++; throw realRateLimitError() }
    let threw = false
    try { await sendReplyChunks(inject, [needle], CHUNK_OPTS, opts0) } catch { threw = true }
    const seen = await countInChannel(needle)
    record(
      '② kill-switch (=0) does NOT retry a transient',
      threw && calls === 1 && seen.count === 0,
      `send attempts=${calls} (expect 1, no retry); threw=${threw}; channel count=${seen.count} (expect 0)`,
    )
    delete process.env.DISCORD_REPLY_MAX_RETRIES
  } catch (e) { record('② kill-switch (=0) does NOT retry a transient', false, `threw: ${(e as Error).message}`) }

  // ── ③ inject one transient (RateLimitError) → retry recovers, message ONCE ───
  try {
    const needle = mark('③ transient-then-recover')
    let calls = 0
    const inject = async (p: SendPayload) => {
      calls++
      if (calls === 1) throw realRateLimitError() // thrown BEFORE realSend → no real msg on attempt 1
      return realSend(p)
    }
    const ids = await sendReplyChunks(inject, [needle], CHUNK_OPTS, buildReplyRetryOpts())
    const seen = await countInChannel(needle)
    record(
      '③ transient retry recovers, NO duplicate',
      calls === 2 && ids.length === 1 && seen.count === 1,
      `send attempts=${calls} (1 fail + 1 ok); returned id=${ids[0]}; channel has EXACTLY ${seen.count} msg (ids=${seen.ids.join(',')})`,
    )
  } catch (e) { record('③ transient retry recovers, NO duplicate', false, `threw: ${(e as Error).message}`) }

  // ── ④ multi-chunk, MIDDLE chunk fails once → every chunk delivered exactly once ─
  try {
    const a = mark('④A-head'), b = mark('④B-mid'), c = mark('④C-tail')
    let bAttempts = 0
    const inject = async (p: SendPayload) => {
      if (p.content.includes('④B-mid')) {
        bAttempts++
        if (bAttempts === 1) throw realRateLimitError() // B fails ONCE, before realSend → no real msg
      }
      return realSend(p)
    }
    const ids = await sendReplyChunks(inject, [a, b, c], CHUNK_OPTS, buildReplyRetryOpts())
    const sa = await countInChannel(a), sb = await countInChannel(b), sc = await countInChannel(c)
    const ok =
      ids.length === 3 && sa.count === 1 && sb.count === 1 && sc.count === 1 && bAttempts === 2
    record(
      '④ multi-chunk, mid fails once → each chunk EXACTLY once (idempotent)',
      ok,
      `delivered ${ids.length} ids; channel counts A=${sa.count} B=${sb.count} C=${sc.count} (all must be 1); B send attempts=${bAttempts} (expect 2: 1 fail + 1 ok); A NOT duplicated`,
    )
  } catch (e) { record('④ multi-chunk idempotent', false, `threw: ${(e as Error).message}`) }

  await client.destroy()

  const failed = results.filter(r => !r.pass)
  console.log(`\n===== FLY-309 E2E SUMMARY (run ${RUN}) =====`)
  console.log(`${results.length - failed.length}/${results.length} PASS`)
  if (failed.length) {
    console.log('FAILURES:'); failed.forEach(r => console.log(`  - ${r.name}: ${r.detail}`))
    process.exit(1)
  }
  console.log('ALL E2E SCENARIOS PASS — evidence is the real messages above (by id) in #cos-test.')
  process.exit(0)
}

main().catch(e => { console.error('HARNESS ERROR:', e); process.exit(3) })
