# Plan: Discord reply 可靠性 guard — FLY-306

**Issue**: FLY-306 (Discord reply tool calls intermittently malformed → messages silently fail to send)
**Date**: 2026-06-17
**Repo**: `xrliAnnie/claude-plugins-official` (fork) — `external_plugins/discord/server.ts`
**Status**: codex-design-approved（Round 2 APPROVED；R1 HIGH = RateLimitError name 修复，3 个 LOW/MED 全 fold）

---

## Scope（本期 vs defer）

Lead（Tadashi）+ Aunt Cass 已拍定的范围切分：

| 失败模式 | 本期 | 说明 |
|---------|------|------|
| **瞬时发送失败导致静默丢消息** | ✅ 修 | `ch.send()` 抛瞬时错(网络/超时/5xx/残余 429)→ 现状立即失败、消息没发出 |
| **partial-failure 重复** | ✅ 修 | 多块回复中途失败 → model 重发整条 → 已发块重复 |
| **headline: model 发出 malformed `<invoke>` → harness 拒解析 → 工具根本没跑** | ❌ defer | 这是 **harness 层** 的序列化问题,reply 工具内部 guard 物理上拦不住(工具没被调用)。Aunt Cass 已 defer 为 follow-up |
| **Codex Lead(Mufasa)的 `DirectDiscordOutboundSender` 路径** | ❌ defer | 另一条独立 send path,本期不碰,要的话另开 follow-up |

> 诚实声明:本期 guard **不解决** issue 头条症状。它硬化的是**更广的静默丢消息类**(瞬时 Discord 发送失败)+ 消除 partial-failure 重复 —— 即 Lead 指令 "① guard(便宜直接):success-check + 显式报错 + bounded retry(尊重 Retry-After)" 所指。

---

## 现状审计（research）

`external_plugins/discord/server.ts` 的 `reply` handler(case `'reply'`,约 L823–883):

```ts
const chunks = chunk(text, limit, mode)
const sentIds: string[] = []
try {
  for (let i = 0; i < chunks.length; i++) {
    const sent = await ch.send({ content: chunks[i], ...files?, ...reply? })
    noteSent(sent.id); sentIds.push(sent.id)
  }
} catch (err) {
  throw new Error(`reply failed after ${sentIds.length} of ${chunks.length} chunk(s) sent: ${msg}`)
}
return { content: [{ type: 'text', text: `sent ...` }] }
// 外层 dispatch catch(L952)→ { isError: true, text: 'reply failed: ...' }
```

**现状结论**：
- ✅ 失败**没有静默吞** —— 已抛显式 error 并经外层 catch 返 `isError: true`。
- ❌ **无 bounded retry**：任何 `ch.send()` 抛错 → 第一次就失败。
- ❌ **无 Retry-After 处理**(应用层)。
- ⚠️ **partial-failure 重复风险**:多块时第 i 块失败,前 i 块已发;model 看到 "failed after K of N" 容易重发整条 → 重复。
- ℹ️ **discord.js v14（14.25.1）内置已处理大部分 429**：`@discordjs/rest` 默认按 `retry_after` 自动等待重试,并对 network/5xx 自动重试(默认 `retries: 3`)后才抛。
  → 故本 guard 是 **discord.js 放弃之后的外层 safety net**,不是重新发明限流处理。这点对避免过度工程很关键。

---

## 设计

### 原则
1. **只对已知瞬时错误 retry**(`ch.send` 非幂等 —— 未知错误盲目 retry 可能造成重复发送)。
2. **per-chunk 幂等**:retry 包在**单块** send 外;已发块绝不重发(沿用现有 loop 结构)。
3. **bounded**:`maxRetries` 上限 + 单次 sleep 上限,绝不无界阻塞 Lead 会话。
4. **尊重 Retry-After**:错误带 `timeToReset`/`retryAfter` 时优先用它(capped)。
5. **耗尽 → 大声结构化报错**:并在错误文案里精确告知"已投递 K/N 块、剩余未发,**勿重发整条、只补发尾部**" —— 消除重复。
6. **结构性分类用 duck-typing 不用 `instanceof`**:bun + 双包实例下 `instanceof` 跨模块脆弱;按 `status`/`code`/`name`/`cause.code` 结构判定更稳。

### 三个纯函数（可单测、无需 live Discord）

**(1) `classifySendError(err): { retryable: boolean; retryAfterMs?: number }`** — PURE
- `name` 以 `'RateLimitError'` **开头**(codex R1 实证:真 `@discordjs/rest` 的 name = `RateLimitError[/channels/:id/messages]` 带路由、且 `status` 为 undefined,精确匹配会漏判)或 `status === 429` → `retryable: true`,取 retryAfterMs。
- `status` 在 500–599 → `retryable: true`。
- `status` 在 400–499(非 429)→ `retryable: false`(权限/格式等永久错)。
- 无 status 的网络/超时:`name === 'AbortError'` 或 `code`∈{ECONNRESET, ETIMEDOUT, ENOTFOUND, EAI_AGAIN, EPIPE, ECONNREFUSED, ECONNABORTED} 或 `code` 以 `UND_ERR` 开头(含 `e.cause?.code`)→ `retryable: true`。
- 其余未知 → `retryable: false`(保守:大声暴露,不冒重复风险)。

**(2) `pickRetryAfterMs(err): number | undefined`** — PURE
- 优先 `err.timeToReset`(@discordjs/rest RateLimitError,ms);否则 `err.retryAfter`(ms);否则 undefined。

**(3) `computeBackoffMs(attempt, { baseMs, capMs, retryAfterMs, jitterRand }): number`** — PURE
- 有 `retryAfterMs` → `min(retryAfterMs, capMs)`。
- 否则指数退避 + 抖动:`min(capMs, baseMs * 2^attempt)` 再叠加 `jitterRand()` 决定的 0–baseMs 抖动(`jitterRand` 注入,测试可定值)。

### orchestration

**`sendWithRetry<T>(fn: () => Promise<T>, opts): Promise<T>`**
```
opts = { maxRetries, baseMs, capMs, sleep(ms), jitterRand(), onRetry?(info) }
```
- attempt 0..maxRetries:`try { return await fn() }` 成功即返。
- catch:`{ retryable, retryAfterMs } = classifySendError(err)`。
  - 不可 retry 或 已是最后一次 → `throw err`(透传原始错误,保留信息)。
  - 否则 `await sleep(computeBackoffMs(attempt, {…, retryAfterMs}))`,`onRetry` 记日志到 stderr,继续。
- `sleep` / `jitterRand` 注入 → 测试用即时假 sleep,不真等。

### 集成进 reply loop（codex R1:抽成可测 helper）
chunk-send loop 抽到 `reply-send.ts` 的 `sendReplyChunks(send, chunks, opts, retryOpts, onSent)` + `buildChunkPayload`(纯),server.ts 注入真 `ch.send` / `noteSent`:
```ts
const sentIds = await sendReplyChunks(
  payload => ch.send(payload), chunks,
  { files, reply_to, replyMode }, replyRetryOpts, noteSent,
)
```
`sendReplyChunks` 内部:每块 `sendWithRetry`,loop 仅成功才前进 → 已发块不重发;耗尽则抛改写文案(见下)。抽出后可用假 channel 单测「块 0 不重发 + 错误文案」。
catch 文案（消除重复）:
```
reply failed after delivering N of M chunk(s): <err>.
The delivered chunk(s) are already in the channel — do NOT resend the full message;
send only the remaining <M-N> chunk(s) to avoid duplicates.
```

### 配置（env override，默认保守）
| const | 默认 | env |
|-------|------|-----|
| `REPLY_MAX_RETRIES` | 3 | `DISCORD_REPLY_MAX_RETRIES` |
| `REPLY_RETRY_BASE_MS` | 500 | `DISCORD_REPLY_RETRY_BASE_MS` |
| `REPLY_RETRY_CAP_MS` | 8000 | `DISCORD_REPLY_RETRY_CAP_MS` |

- env 解析走纯函数 `parseIntInRange`(codex R1:**严格整数** —— `'3abc'`/`'3.9'` 视为非法回退默认,非 parseInt 的静默截断)+ 范围校验,可单测。
- `REPLY_MAX_RETRIES=0` → 退回当前"一次即失败"行为(可逆逃生口)。

---

## TDD 测试清单（bun test —— plugin 本期新建测试框架；**33/33 绿**）

`retry.test.ts`(24)— `classifySendError` / `pickRetryAfterMs` / `computeBackoffMs` / `sendWithRetry` / `parseIntInRange`,含:
- RateLimitError 精确 name + **真 `@discordjs/rest` RateLimitError**(import 真类、name 带路由、status undefined —— codex R1 HIGH 的回归测试)+ 路由 name 字符串形 → 全 retryable + 取 retryAfterMs。
- 429 / 5xx → retryable;4xx(403/400)→ not。网络/超时码(含 `cause.code`、`UND_ERR*`、AbortError)→ retryable;未知 → not。
- backoff:retryAfter 优先且 capped;指数退避随 attempt 增、被 cap 钳、注入 rand 抖动可预测。
- sendWithRetry:首次成功零 sleep;瞬时错重试后成功(delays 符合 backoff);耗尽抛原始错;永久错立即抛;retryAfter 传给 sleep;onRetry 回调。
- `parseIntInRange`:合法值;缺省回退;`'3abc'`/`'3.9'`/空/越界 → 回退;首尾空白容忍。

`reply-send.test.ts`(9)— `buildChunkPayload` + `sendReplyChunks` 集成(假 channel):
- payload:files 仅首块、quote-reply 按 first/all/off。
- **核心 FLY-306 断言**:块 0 成功、块 1 耗尽 → **块 0 恰发一次不重发**、块 2 不触发、错误文案含"delivered 1 of 3 … do NOT resend the full message; send only the remaining 2"。
- 块内瞬时错重试不重复前块;无投递时无 guidance 后缀;永久错 fail-fast;**真 RateLimitError 经 loop 被重试**。

---

## 风险 / 兼容

- **行为变化**:仅在"原本会失败"的路径上增加重试 → 正常路径零变化(成功立即返,零 sleep)。
- **最坏阻塞**:`maxRetries(3) × capMs(8s)` ≈ 最多 ~24s 额外等待,且仅在持续瞬时失败时;cap 防无界。
- **重复风险(诚实声明 — at-least-once 边界)**:retry 只包单块、只对已知瞬时错。但网络类错误存在经典的 at-least-once 边界:`ch.send` 实际已被 Discord 接受、响应却在网络中丢失(抛 ECONNRESET 等)→ 重试会产生**一条**重复消息。Discord 消息 API **无 idempotency key**,本层无法做到 exactly-once。**权衡接受**:静默丢消息(本 bug)>> 罕见重复(用户/Lead 可见、可纠);且这与 discord.js 自身默认对网络错误的 at-least-once 重试语义一致。**净效果**仍是减少重复(消除现状高频的 partial-failure 整条重发路径),而非新增。
- **可逆**:`DISCORD_REPLY_MAX_RETRIES=0` 退回旧"一次即失败"行为。
- **部署**:active plugin 从 fork→cache 分发,merge 后需 Lead 验证 cache 更新(Tadashi 手动跟)。

## Out of scope（follow-up）
- harness 层 malformed `<invoke>` 序列化根因。
- Codex `DirectDiscordOutboundSender` 同类硬化。
- "未确认回复" 的跨-tool-call watchdog(需跨调用状态,超出"便宜 guard")。
