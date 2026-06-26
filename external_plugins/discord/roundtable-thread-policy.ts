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
	/** Per-thread bot-only continuation budget (small; conservative default 2). */
	budgetN: number;
}

/** Parse the roundtable config. Returns undefined (feature OFF / byte-compat) when no
 * roundtable channel id is resolvable from either source — the plugin then behaves
 * exactly as before (vanilla non-Flywheel installs are unaffected).
 *
 * FLY-569: `routing` carries a SHARED NON-TOKEN default (the channel id read from
 * ~/.flywheel/roundtable.json by server.ts). `env` still WINS — wrapper-launched
 * dept leads + the QA Room keep their exact behavior. reply-in-thread is now
 * DEFAULT-ON whenever a channel is resolved (opt-out only via explicit "0"), so
 * token-isolated companion leads (Belle/atlas/rafiki) — which never set the env —
 * reply into the thread without any per-lead config. `autoContinue` is UNCHANGED
 * (still explicit "1", default-off) to preserve the FLY-220/FLY-314 anti-loop. */
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
	const autoContinue = env.FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE === "1";
	const rawN = Number.parseInt(
		(env.FLYWHEEL_ROUNDTABLE_THREAD_BUDGET ?? "").trim(),
		10,
	);
	const budgetN = Number.isFinite(rawN) && rawN > 0 ? rawN : 2;
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

export interface InboundChannelInfo {
	channelId: string;
	messageId: string;
	isThread: boolean;
	/** Parent channel id when the message is in a thread, else null. */
	parentId: string | null;
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
}

/** R1 reply routing. Top-level roundtable message → its topic thread (id == message id).
 * Everything else (already-in-thread, other channels, feature off) → unchanged. */
export function resolveRoundtableInboundChatId(
	info: InboundChannelInfo,
	cfg: RoundtableConfig,
): InboundChatIdResolution {
	if (
		cfg.replyInThread &&
		!info.isThread &&
		info.channelId === cfg.channelId
	) {
		// Thread is created from the message → thread id == message id.
		return {
			chatId: info.messageId,
			sourceMessageId: info.messageId,
			routedToThread: true,
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

	// (2) BOT author. Kill-switch / feature off → mention-required (byte-compat with the old
	//     gate; preserves the FLY-220/FLY-314 anti-loop default — bots never auto-continue
	//     without an explicit @ unless `autoContinue` is enabled).
	if (!cfg.autoContinue) {
		return { handle: input.isExplicitMention };
	}

	// (3) bot-authored trigger. Only thread MEMBERS auto-continue; fail closed on
	//     unknown/non-member (never relax when membership is not proven).
	if (input.isMember !== true) {
		return { handle: false };
	}

	// (4) member bot trigger → strictly budget-gated. An explicit <@bot> / quote-reply
	//     from a bot does NOT bypass or reset the budget; it consumes it like any other
	//     bot trigger. A MISSING entry means "exhausted" (NOT a fresh budget) — the
	//     budget is seeded only on a new top-level topic engage or a human message
	//     (Codex code review R1#1), so process restart / state loss falls on the safe
	//     side (the thread returns to mention-required until a human/new-topic reset).
	const remaining = store.budgets.get(input.threadId) ?? 0;
	if (remaining > 0) {
		store.budgets.set(input.threadId, remaining - 1);
		return { handle: true };
	}
	return { handle: false };
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
