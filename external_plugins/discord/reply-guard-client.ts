import {
  appendFileSync,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseIntInRange } from './retry'

export interface GuardOutcome {
  kind: 'allow' | 'deny' | 'not_deployed' | 'unauthorized' | 'unavailable'
  probe: {
    url: string
    attempts: number
    timeoutMs: number
    outcome: 'ok' | 'http' | 'abort' | 'network'
    httpStatus?: number
    error?: string
    latencyMs: number
    at: string
  }
  local?: {
    classification:
      | 'core'
      | 'roundtable_thread'
      | 'own_top_level'
      | 'other'
      | 'legacy_broad'
    issueTokens: string[]
    decision: 'allow' | 'deny'
  }
  deny?: { reason: string; issues?: string[]; guidance?: string }
}

export interface ReplyGuardClientOptions {
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  env?: NodeJS.ProcessEnv
  audit?: (row: Record<string, unknown>) => void
}

function fileAudit(env: NodeJS.ProcessEnv, row: Record<string, unknown>): void {
  const dir =
    env.DISCORD_STATE_DIR ?? join(homedir(), '.claude', 'channels', 'discord')
  const path = join(dir, 'reply-guard-audit.jsonl')
  const line = `${JSON.stringify(row)}\n`
  const limit = 1024 * 1024
  // Never grow either rotated file beyond the bound, including an oversized error.
  if (Buffer.byteLength(line) > limit) return
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  if (
    existsSync(path) &&
    statSync(path).size + Buffer.byteLength(line) > limit
  ) {
    renameSync(path, `${path}.1`)
  }
  appendFileSync(path, line, { mode: 0o600 })
}

export function createReplyGuardClient(opts: ReplyGuardClientOptions = {}) {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetchImpl ?? fetch
  const now = opts.now ?? Date.now
  const sleep =
    opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const audit = opts.audit ?? ((row) => fileAudit(env, row))

  async function evaluate(
    chatId: string,
    text: string,
    context: { roundtableThread?: boolean } = {},
  ): Promise<GuardOutcome> {
    const bridgeUrl = env.BRIDGE_URL
    const apiToken = env.TEAMLEAD_API_TOKEN
    const leadId = env.LEAD_ID
    const projectName = env.PROJECT_NAME
    const started = now()
    const timeoutMs = parseIntInRange(
      env.TEAMLEAD_REPLY_GUARD_TIMEOUT_MS,
      4000,
      500,
      10000,
    )
    const requestUrl = `${(bridgeUrl ?? '').replace(/\/$/, '')}/api/discord/reply-guard`
    const redact = (value: string) =>
      apiToken ? value.split(apiToken).join('[redacted]') : value
    const url = redact(requestUrl)
    let probe: GuardOutcome['probe'] = {
      url,
      attempts: 0,
      timeoutMs,
      outcome: 'ok',
      latencyMs: 0,
      at: new Date(started).toISOString(),
    }
    if (!bridgeUrl || !apiToken || !leadId || !projectName)
      return { kind: 'allow', probe }

    const finish = (result: GuardOutcome): GuardOutcome => {
      if (result.kind !== 'allow' && result.kind !== 'not_deployed') {
        try {
          audit({
            ts: new Date(now()).toISOString(),
            leadId,
            chatId,
            kind: result.kind,
            probe: result.probe,
            ...(result.local ? { local: result.local } : {}),
            ...(result.deny ? { deny: { reason: result.deny.reason } } : {}),
          })
        } catch {
          /* Telemetry cannot block collaboration. */
        }
      }
      return result
    }
    let failureKind: 'unauthorized' | 'unavailable' = 'unavailable'
    for (let attempt = 1; attempt <= 2; attempt++) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      let status: number | undefined
      try {
        const response = await fetchImpl(requestUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${apiToken}`,
          },
          body: JSON.stringify({ projectName, leadId, chatId, text }),
          signal: controller.signal,
        })
        status = response.status
        probe = {
          url,
          attempts: attempt,
          timeoutMs,
          outcome: response.ok ? 'ok' : 'http',
          httpStatus: status,
          latencyMs: now() - started,
          at: new Date(started).toISOString(),
        }
        if (status === 404) return { kind: 'not_deployed', probe }
        if (!response.ok) {
          failureKind =
            status === 401 || status === 403 ? 'unauthorized' : 'unavailable'
          break
        }
        const decision = (await response.json()) as {
          allow?: boolean
          reason?: string
          issues?: string[]
          guidance?: string
        } | null
        probe.latencyMs = now() - started
        if (decision?.allow === false) {
          return finish({
            kind: 'deny',
            probe,
            deny: {
              reason:
                typeof decision.reason === 'string'
                  ? decision.reason
                  : 'denied',
              ...(Array.isArray(decision.issues)
                ? {
                    issues: decision.issues.filter(
                      (issue): issue is string => typeof issue === 'string',
                    ),
                  }
                : {}),
              ...(typeof decision.guidance === 'string'
                ? { guidance: decision.guidance }
                : {}),
            },
          })
        }
        return { kind: 'allow', probe }
      } catch (error) {
        const outcome =
          controller.signal.aborted ||
          (error as { name?: string })?.name === 'AbortError'
            ? 'abort'
            : status !== undefined
              ? 'http'
              : 'network'
        const message = error instanceof Error ? error.message : String(error)
        probe = {
          url,
          attempts: attempt,
          timeoutMs,
          outcome,
          ...(status !== undefined ? { httpStatus: status } : {}),
          error: redact(message).slice(0, 1024),
          latencyMs: now() - started,
          at: new Date(started).toISOString(),
        }
        if (outcome === 'http' || attempt === 2) break
      } finally {
        clearTimeout(timer)
      }
      await sleep(250)
    }

    const prefixes = new Set(
      (env.TEAMLEAD_ISSUE_PREFIXES ?? 'FLY,GEO')
        .split(',')
        .map((s) => s.trim().toUpperCase())
        .filter(Boolean),
    )
    // Keep the server's original boundary/prefix matching semantics.
    const issueTokens = [
      ...new Set(
        [...text.matchAll(/\b([A-Za-z]{2,})-(\d+)\b/g)]
          .filter((m) => prefixes.has(m[1]!.toUpperCase()))
          .map((m) => `${m[1]!.toUpperCase()}-${m[2]}`),
      ),
    ]
    const own = env.DISCORD_OWN_CHAT_CHANNEL
    const classification: NonNullable<GuardOutcome['local']>['classification'] =
      env.DISCORD_CORE_CHANNEL && chatId === env.DISCORD_CORE_CHANNEL
        ? 'core'
        : context.roundtableThread
          ? 'roundtable_thread'
          : !own
            ? 'legacy_broad'
            : chatId === own
              ? 'own_top_level'
              : 'other'
    const denied =
      issueTokens.length > 0 &&
      (classification === 'own_top_level' || classification === 'legacy_broad')
    const result: GuardOutcome = {
      kind: failureKind,
      probe,
      local: {
        classification,
        issueTokens,
        decision: denied ? 'deny' : 'allow',
      },
    }
    if (denied)
      result.deny = {
        reason:
          classification === 'legacy_broad'
            ? 'guard_unavailable_legacy_broad'
            : failureKind === 'unauthorized'
              ? 'guard_unauthorized'
              : 'guard_unavailable',
        guidance:
          'Bridge routing guard unavailable; do not post issue content at the chat-channel top level — use POST /api/chat-threads/send when the Bridge is healthy.',
      }
    return finish(result)
  }
  return { evaluate }
}

/** Preserve the Bridge reason and display the actual evaluated probe beside it. */
export function formatGuardDeny(outcome: GuardOutcome): string {
  const deny = outcome.deny
  const p = outcome.probe
  const issues = deny?.issues?.length
    ? ` Issues: ${deny.issues.join(', ')}.`
    : ''
  const fields = [
    `url=${p.url}`,
    `attempts=${p.attempts}`,
    `timeout_ms=${p.timeoutMs}`,
    `outcome=${p.outcome}`,
    ...(p.httpStatus !== undefined ? [`http_status=${p.httpStatus}`] : []),
    ...(p.error ? [`error=${JSON.stringify(p.error)}`] : []),
    `latency_ms=${p.latencyMs}`,
    `at=${p.at}`,
    ...(outcome.local ? [`local=${outcome.local.classification}`] : []),
  ]
  return `BLOCKED by routing guard (${deny?.reason ?? 'denied'}).${issues} ${deny?.guidance ?? ''} probe={${fields.join(' ')}}`.replace(
    /\.  probe=/,
    '. probe=',
  )
}
