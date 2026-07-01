/**
 * FLY-314 Phase 2 Part(b) — roundtable topic-thread policy (PURE, unit-tested).
 *
 * Two jobs, both default-OFF (byte-compat when the env is unset):
 *  1. reply routing (R1): a top-level message in the roundtable parent channel is
 *     delivered to the agent with chat_id rewritten to the topic thread id (== the
 *     source message id — the Discord "thread from message" invariant), so the agent's
 *     reply lands INSIDE the thread instead of flat in the parent.
 *  2. no-@ in-thread continuation with a BOUNDED anti-loop budget. The central safety
 *     contract (Codex design review R1#1): inside a topic thread, ANY bot-authored
 *     trigger — even one that @-mentions this bot or quote-replies to it — consumes a
 *     finite per-thread budget and CANNOT reset or bypass it. The budget resets ONLY on
 *     a non-bot human message (or operator override / a brand-new top-level topic, which
 *     a fresh thread provides naturally). => bot-only loops terminate in <= budget steps.
 *
 * This module is intentionally free of any Discord/network side effects so the loop
 * proof can be exhaustively unit-tested (including the 2-bot adversarial case).
 */

export interface RoundtableConfig {
	/** The roundtable parent channel id (where top-level topics are posted). */
	channelId: string;
	/** Route replies to top-level roundtable messages into the topic thread. */
	replyInThread: boolean;
	/** Allow no-@ continuation inside topic threads (kill-switch: false = mention-required). */
	autoContinue: boolean;
	/** Per-thread bot-only continuation budget (default DEFAULT_ROUNDTABLE_THREAD_BUDGET). */
	budgetN: number;
}

/** FLY-676 — default per-thread bot-only anti-loop budget. Raised from 2 → 12 so a natural
 * multi-turn back-and-forth between thread members is not cut off, while a runaway bot-only
 * loop still terminates in <= 12 steps per Lead (reset only by a human message / new topic).
 * The budget is the structural FLY-220 circuit-breaker; the small 2 was a QA-only conservative
 * default that, once member-follow went default-on (FLY-676), would have truncated real talk. */
export const DEFAULT_ROUNDTABLE_THREAD_BUDGET = 12;

/** Parse the roundtable config. Returns undefined (feature OFF / byte-compat) when no
 * roundtable channel id is resolvable from either source — the plugin then behaves
 * exactly as before (vanilla non-Flywheel installs are unaffected).
 *
 * FLY-569: `routing` carries a SHARED NON-TOKEN default (the channel id read from
 * ~/.flywheel/roundtable.json by server.ts). `env` still WINS — wrapper-launched
 * dept leads + the QA Room keep their exact behavior. reply-in-thread is now
 * DEFAULT-ON whenever a channel is resolved (opt-out only via explicit "0"), so
 * token-isolated companion leads (Belle/atlas/rafiki) — which never set the env —
 * reply into the thread without any per-lead config.
 *
 * FLY-676: `autoContinue` (no-@ in-thread member-follow) is now ALSO DEFAULT-ON
 * (opt-out only via explicit `FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE=0`, the
 * kill-switch). The per-thread anti-loop budget (default raised 2 → 12) remains the
 * FLY-220/FLY-314 circuit-breaker — a bot-only loop still terminates in <= budget
 * steps, reset only by a human message / new topic. */
export function loadRoundtableConfig(
	env: Record<string, string | undefined>,
	routing?: { channelId?: string },
): RoundtableConfig | undefined {
	const channelId =
		(env.FLYWHEEL_ROUNDTABLE_CHANNEL_ID ?? "").trim() ||
		(routing?.channelId ?? "").trim();
	if (!channelId) return undefined;
	// DEFAULT-ON: on unless explicitly disabled with "0" (was: required "1").
	const replyInThread = env.FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD !== "0";
	// FLY-676 DEFAULT-ON: member-follow (no-@ in-thread continuation) is now on unless
	// explicitly disabled with "0" (was: required "1"). `=0` is the kill-switch that restores
	// the pre-FLY-676 mention-required behavior. Mirrors the FLY-569 replyInThread default-on.
	const autoContinue = env.FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE !== "0";
	const rawN = Number.parseInt(
		(env.FLYWHEEL_ROUNDTABLE_THREAD_BUDGET ?? "").trim(),
		10,
	);
	const budgetN =
		Number.isFinite(rawN) && rawN > 0 ? rawN : DEFAULT_ROUNDTABLE_THREAD_BUDGET;
	return { channelId, replyInThread, autoContinue, budgetN };
}

/**
 * FLY-569 R1#2 — classify the POST .../threads create response (PURE).
 *
 * An independently-launched companion bot may have View/Send in the roundtable
 * parent but NOT `Create Public Threads`. The FLY-314 auto-thread manager / host
 * bot creates the topic thread; a member bot only needs to send into it. So a
 * failed create is NOT necessarily fatal — the thread may already exist. The
 * server orchestrates: created/exists → route into the thread; confirm-via-get →
 * GET the thread (id == message id) with a bounded retry for the manager race;
 * failed → fall back to the parent channel (the prior safe behavior).
 */
export function classifyThreadCreate(
	status: number,
	bodyCode?: number,
): "created" | "exists" | "confirm-via-get" | "failed" {
	if (status >= 200 && status < 300) return "created";
	// "A thread has already been created for this message" → code 160004.
	if ((status === 400 || status === 409) && bodyCode === 160004) return "exists";
	// 403 (no create perm), 404 (race / not yet), 429 (rate limited), 5xx (transient)
	// → the thread may still exist (host/Bridge made it); confirm via GET.
	if (status === 403 || status === 404 || status === 429 || status >= 500)
		return "confirm-via-get";
	return "failed"; // other 4xx (e.g. 400 without 160004) → real failure.
}

/** FLY-569 R1#2 — a GET /channels/{threadId} that returns 200 confirms the thread
 * exists; anything else does not (PURE). */
export function threadGetConfirmsExistence(status: number): boolean {
	return status === 200;
}

/** Discord thread channel types (10 announcement, 11 public, 12 private). */
const THREAD_TYPES = new Set([10, 11, 12]);

/**
 * FLY-314 fix (Codex R4 note 3) — a GET /channels/{id} 200 alone does NOT prove the
 * fetched channel is a topic thread of THIS roundtable. Verify the body: it must be a
 * thread type AND its parent must be the configured roundtable channel. Used by the
 * plugin's confirm-only follow-up route (never present an unconfirmed / wrong-parent
 * id to the agent) and hardens the create-vs-confirm race path. PURE.
 */
export function confirmThreadUnderParent(
	body: { type?: unknown; parent_id?: unknown } | null | undefined,
	parentChannelId: string,
): boolean {
	if (!body) return false;
	return (
		typeof body.type === "number" &&
		THREAD_TYPES.has(body.type) &&
		body.parent_id === parentChannelId
	);
}

/** FLY-314 fix — placeholder + minimum semantic chars for a real topic (mirror of the
 * flywheel `roundtable-text` helpers so all three thread creators agree). */
export const ROUNDTABLE_PLACEHOLDER_NAME = "Roundtable topic";
const MIN_TOPIC_CHARS = 3;

function stripDiscordMarkup(content: string): string {
	return content
		.replace(/<a?:\w+:\d+>/g, "") // custom emoji <:x:1> / <a:x:1>
		.replace(/<@[!&]?\d+>/g, "") // user <@1>/<@!1> + role <@&1> mentions
		.replace(/<#\d+>/g, "") // channel mentions <#1>
		.replace(/\s+/g, " ")
		.trim();
}

/** FLY-314 fix — correct-from-start descriptive thread name (mirror of flywheel
 * `deriveRoundtableThreadName`), so a plugin-created topic thread is never the generic
 * "Roundtable topic" placeholder. PURE. */
export function deriveRoundtableThreadName(content: string): string {
	const cleaned = stripDiscordMarkup(content).slice(0, 90);
	return (cleaned || ROUNDTABLE_PLACEHOLDER_NAME).slice(0, 100);
}

/** FLY-314 fix — is this message too thin to open its own topic thread? Strips
 * Discord markup + Unicode pictographs, then requires >= MIN_TOPIC_CHARS letter/number
 * characters (mirror of flywheel `isTopicNoise`, incl. the multi-emoji case). PURE. */
export function isTopicNoise(content: string): boolean {
	const stripped = stripDiscordMarkup(content).replace(
		/\p{Extended_Pictographic}/gu,
		"",
	);
	const semantic = (stripped.match(/[\p{L}\p{N}]/gu) ?? []).length;
	return semantic < MIN_TOPIC_CHARS;
}

/**
 * FLY-314 fix — redirect bookkeeping for the `reply_to` strip, extracted PURE + BOUNDED
 * so it is unit-testable without starting Discord (Codex code review R1 MEDIUM + LOW).
 *
 * threadId -> the set of parent-channel message ids redirected into that thread. A
 * reply into the thread must strip a `reply_to` pointing at ANY of them (a
 * cross-channel reference Discord rejects). BOTH dimensions are bounded: the number of
 * threads (`maxThreads`) AND the ids per hot thread (`maxPerThread`, oldest evicted) —
 * so a single long-lived active topic can't grow the per-thread set without limit.
 */
export function rememberRoundtableRedirect(
	map: Map<string, Set<string>>,
	threadId: string,
	sourceMessageIds: string[],
	opts: { maxThreads: number; maxPerThread: number },
): void {
	const set = map.get(threadId) ?? new Set<string>();
	for (const id of sourceMessageIds) {
		if (!id) continue;
		set.add(id);
		// Insertion-ordered: evict the oldest id past the per-thread cap.
		while (set.size > opts.maxPerThread) {
			const oldest = set.values().next().value;
			if (oldest === undefined) break;
			set.delete(oldest);
		}
	}
	// Re-insert so this thread is treated as newest (MRU) for thread-level eviction.
	map.delete(threadId);
	map.set(threadId, set);
	while (map.size > opts.maxThreads) {
		const oldestThread = map.keys().next().value;
		if (oldestThread === undefined) break;
		map.delete(oldestThread);
	}
}

/** FLY-314 fix — should a reply's `reply_to` be stripped? True iff it targets a
 * parent-channel id we redirected into this thread (cross-channel ref). PURE. */
export function shouldStripRoundtableReplyTo(
	map: Map<string, Set<string>>,
	chatId: string,
	replyTo: string | undefined,
): boolean {
	return !!replyTo && (map.get(chatId)?.has(replyTo) ?? false);
}

export interface InboundChannelInfo {
	channelId: string;
	messageId: string;
	isThread: boolean;
	/** Parent channel id when the message is in a thread, else null. */
	parentId: string | null;
	/** FLY-314 fix: the referenced message id when this is a Discord REPLY (follow-up). */
	referencedMessageId?: string | null;
	/** FLY-314 fix: message text → correct-from-start name + noise classification. */
	content?: string;
}

export interface InboundChatIdResolution {
	/** The chat_id to present to the agent (the reply target). */
	chatId: string;
	/** Set when chat_id was rewritten to a topic thread — the source message id whose
	 * thread we routed into. The reply handler must NOT use this as a `reply_to`
	 * reference (cross-channel reference would fail); strip it. */
	sourceMessageId?: string;
	/** True when a top-level roundtable message was rewritten to its topic thread. */
	routedToThread: boolean;
	/**
	 * FLY-314 fix: how the server must ensure the target thread.
	 *  - undefined/false → create-or-confirm (a FRESH topic; may POST create).
	 *  - true → confirm-only (a FOLLOW-UP into an existing thread; GET-verify only,
	 *    NEVER create — else a follow-up over-spawns on the referenced id).
	 */
	confirmOnly?: boolean;
	/** FLY-314 fix: correct-from-start name to give a freshly-created topic thread. */
	threadName?: string;
}

/**
 * FLY-314 reply routing (fix). For a top-level roundtable message:
 *  - a FOLLOW-UP (Discord reply) routes into the REFERENCED message's thread
 *    (confirm-only, never create) so it joins the topic instead of opening a second
 *    thread; if that thread can't be confirmed the server keeps the parent channel.
 *  - a NOISE message (pure emoji / short ack) is NOT routed to a thread at all.
 *  - a fresh topic routes to its own thread (id == message id) with a descriptive
 *    correct-from-start name.
 * Everything else (already-in-thread, other channels, feature off) → unchanged.
 */
export function resolveRoundtableInboundChatId(
	info: InboundChannelInfo,
	cfg: RoundtableConfig,
): InboundChatIdResolution {
	if (cfg.replyInThread && !info.isThread && info.channelId === cfg.channelId) {
		// Follow-up (Discord reply) → route into the referenced topic thread, confirm-only.
		if (info.referencedMessageId) {
			return {
				chatId: info.referencedMessageId,
				sourceMessageId: info.referencedMessageId,
				routedToThread: true,
				confirmOnly: true,
			};
		}
		// Noise (pure emoji / short ack) → do not open a topic thread; reply in parent.
		if (info.content !== undefined && isTopicNoise(info.content)) {
			return { chatId: info.channelId, routedToThread: false };
		}
		// Fresh topic → its own thread (id == message id), create-or-confirm + name.
		return {
			chatId: info.messageId,
			sourceMessageId: info.messageId,
			routedToThread: true,
			confirmOnly: false,
			threadName: deriveRoundtableThreadName(info.content ?? ""),
		};
	}
	return { chatId: info.channelId, routedToThread: false };
}

/** Is this channel a roundtable TOPIC THREAD (a thread whose parent is the roundtable)? */
export function isRoundtableTopicThread(
	info: { isThread: boolean; parentId: string | null },
	cfg: RoundtableConfig,
): boolean {
	return info.isThread && info.parentId === cfg.channelId;
}

/** Opaque per-thread budget store (process-local; cleared on restart = safe side:
 * a restart returns the thread to mention-required until a fresh human/@ reset). */
export interface ThreadBudgetStore {
	budgets: Map<string, number>;
}
export function createThreadBudgetStore(): ThreadBudgetStore {
	return { budgets: new Map() };
}

/**
 * Seed (reset) a thread's bot-only budget to N. Called ONLY on a genuine reset event:
 * a new top-level topic the Lead engages (its reply is routed into the thread) or a
 * non-bot human message. A bot-authored trigger must NEVER seed — see
 * decideTopicThreadHandling (Codex code review R1#1): a missing entry on a bot trigger
 * means "exhausted/drop", so process restart / state loss is NOT an implicit reset.
 */
export function seedThreadBudget(
	store: ThreadBudgetStore,
	threadId: string,
	budgetN: number,
): void {
	store.budgets.set(threadId, budgetN);
}

export interface TopicThreadHandlingInput {
	threadId: string;
	/** Message author is THIS bot. */
	authorIsSelf: boolean;
	/** Message author is a bot (any bot, including sibling Leads). */
	authorIsBot: boolean;
	/** Message author is a non-bot human (= !authorIsBot for a real author). */
	authorIsHuman: boolean;
	/** This bot is explicitly pointed at (Discord mentions array, <@id> token, or a
	 * quote-reply to one of this bot's messages). NOTE: an explicit mention from a BOT
	 * does NOT bypass the budget (R1#1). */
	isExplicitMention: boolean;
	/** This bot is a member of the thread. undefined = unknown → fail-closed. */
	isMember: boolean | undefined;
}

export interface TopicThreadHandlingDecision {
	handle: boolean;
}

/**
 * Decide whether to deliver an inbound topic-thread message to the agent, applying the
 * bounded anti-loop budget. Mutates `store` (consumes/resets budget). See R1#1.
 */
export function decideTopicThreadHandling(
	input: TopicThreadHandlingInput,
	store: ThreadBudgetStore,
	cfg: RoundtableConfig,
): TopicThreadHandlingDecision {
	// (0) never act on our own messages.
	if (input.authorIsSelf) return { handle: false };

	// (1) FLY-576: a non-bot HUMAN (founder/operator) is surfaced by DEFAULT — no @ needed,
	//     independent of `autoContinue`. A member sees every human message in the thread; a
	//     non-member still needs an explicit @. The human message also RESETS the bot budget
	//     (a genuine reset event), so any subsequent bot continuation (when `autoContinue` is
	//     on) starts fresh. A human cannot form a bot-to-bot loop → structurally melee-immune.
	//     (Pre-FLY-576 this branch was gated behind `autoContinue`, which dropped the
	//     founder's non-@ messages in production where `autoContinue` is off.)
	if (!input.authorIsBot) {
		store.budgets.set(input.threadId, cfg.budgetN);
		return { handle: input.isMember === true || input.isExplicitMention };
	}

	// (2) FLY-676: BOT author who is a PROVEN MEMBER follows the thread WITHOUT a fresh @,
	//     bounded by the per-thread anti-loop budget. This is the real new behavior — an active
	//     participant keeps the back-and-forth going (the bug Annie observed: members had to be
	//     @-mentioned every line). Default-on; `autoContinue=0` (kill-switch) routes to (3).
	//     An explicit @ also CONSUMES budget — it never bypasses or resets it (FLY-314 R1#1);
	//     a MISSING entry means "exhausted" (NOT a fresh budget), so a process restart / state
	//     loss / an un-seeded initiator falls on the safe side (the thread returns to
	//     mention-required until a human / new-topic / initiator-seed reset).
	if (cfg.autoContinue && input.isMember === true) {
		const remaining = store.budgets.get(input.threadId) ?? 0;
		if (remaining > 0) {
			store.budgets.set(input.threadId, remaining - 1);
			return { handle: true };
		}
		return { handle: false };
	}

	// (3) Everyone else — a non-member / unknown-membership bot, OR autoContinue off (the
	//     kill-switch) — stays mention-required. This is byte-IDENTICAL to the pre-FLY-676
	//     production path (autoContinue off → all bots gated on isExplicitMention), so FLY-676
	//     introduces NO new non-member reply surface. A mid-thread @ to a non-member still
	//     yields the single reply the prompt contract promises (top-level @ semantics —
	//     unbudgeted, exactly as the parent-channel @ has always been). The budgeted relaxation
	//     in (2) is reserved for PROVEN members only (fail-closed on unknown membership).
	return { handle: input.isExplicitMention };
}

/**
 * FLY-676 — decide whether to seed the initiator's anti-loop budget for a thread (PURE).
 *
 * The Lead that STARTS a top-level roundtable topic filters out its own post (echo immunity),
 * so it never seeds via the inbound topic-engage path (`server.ts` only seeds when a top-level
 * inbound is routed to a thread). Under the (2) member-budget path it would then drop the
 * sibling's first reply — even an explicit @ — because its budget is missing (= exhausted).
 * Fix: when a Lead sends to the roundtable PARENT channel (a top-level topic; the future thread
 * id == the sent message id), seed its budget so it can hear the replies it asked for. Only
 * when autoContinue is on (the budget path is active). `server.ts` is the thin glue that, on a
 * successful parent-channel send, calls `seedThreadBudget` for the returned message id(s).
 *
 * restart-safe: the seed lives only in-process; a restart loses it and the initiator does not
 * re-post the topic, so there is no spurious re-seed — the thread returns to mention-required.
 */
export function shouldSeedInitiatorBudget(input: {
	sentToChannelId: string;
	cfg: RoundtableConfig;
}): boolean {
	return input.cfg.autoContinue && input.sentToChannelId === input.cfg.channelId;
}

/**
 * FLY-576 — decide whether the topic-thread membership probe is worth running for THIS
 * message (PURE, so the acceptance-critical call site stays a thin, untested glue; `server.ts`
 * is not importable — it ends with `client.login`). Probe only when membership can change the
 * `decideTopicThreadHandling` outcome:
 *   - BOT author: membership matters only on the `autoContinue` budget path.
 *   - NON-BOT human: membership matters only when there is NO explicit @ (an explicit @ is
 *     handled by `isExplicitMention` regardless of membership — skip the probe + its 5s
 *     timeout on an already-decided message).
 */
export function shouldProbeTopicThreadMembership(input: {
	authorIsBot: boolean;
	isExplicitMention: boolean;
	autoContinue: boolean;
}): boolean {
	if (input.authorIsBot) return input.autoContinue;
	return !input.isExplicitMention;
}
