/**
 * FLY-314 Phase 2 Part(b) — tests for the roundtable topic-thread policy:
 * reply routing (R1) + in-thread no-@ continuation with bounded anti-loop budget.
 *
 * The central safety contract (Codex design review R1#1, NON-NEGOTIABLE):
 * inside a topic thread, ANY bot-authored trigger — even one that @-mentions this
 * bot or quote-replies to it — CONSUMES finite per-thread budget and CANNOT reset
 * or bypass it. Budget resets ONLY on a non-bot human message, an operator override,
 * or a brand-new top-level topic. => bot-only loops terminate in <= N steps.
 */
import { test, expect, describe } from "bun:test";
import {
	loadRoundtableConfig,
	resolveRoundtableInboundChatId,
	createThreadBudgetStore,
	decideTopicThreadHandling,
	type RoundtableConfig,
} from "./roundtable-thread-policy";

const RT = "1512578695468941333"; // roundtable parent channel id
const cfgOn: RoundtableConfig = {
	channelId: RT,
	replyInThread: true,
	autoContinue: true,
	budgetN: 2,
};

describe("loadRoundtableConfig", () => {
	test("unset → undefined (byte-compat OFF)", () => {
		expect(loadRoundtableConfig({})).toBeUndefined();
	});
	test("channel id without reply-in-thread → reply routing off", () => {
		const c = loadRoundtableConfig({ FLYWHEEL_ROUNDTABLE_CHANNEL_ID: RT });
		expect(c?.channelId).toBe(RT);
		expect(c?.replyInThread).toBe(false);
		expect(c?.autoContinue).toBe(false);
	});
	test("full enable", () => {
		const c = loadRoundtableConfig({
			FLYWHEEL_ROUNDTABLE_CHANNEL_ID: RT,
			FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD: "1",
			FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE: "1",
		});
		expect(c?.replyInThread).toBe(true);
		expect(c?.autoContinue).toBe(true);
	});
	test("reply-in-thread set but no channel id → undefined (can't identify roundtable)", () => {
		expect(
			loadRoundtableConfig({ FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD: "1" }),
		).toBeUndefined();
	});
});

describe("resolveRoundtableInboundChatId (R1 reply routing)", () => {
	test("top-level roundtable message → chat_id rewritten to thread id (== msg id)", () => {
		const r = resolveRoundtableInboundChatId(
			{ channelId: RT, messageId: "M1", isThread: false, parentId: null },
			cfgOn,
		);
		expect(r.chatId).toBe("M1");
		expect(r.sourceMessageId).toBe("M1");
		expect(r.routedToThread).toBe(true);
	});
	test("message already inside a roundtable topic thread → chat_id unchanged (stays in thread)", () => {
		const r = resolveRoundtableInboundChatId(
			{ channelId: "T1", messageId: "X", isThread: true, parentId: RT },
			cfgOn,
		);
		expect(r.chatId).toBe("T1");
		expect(r.routedToThread).toBe(false);
	});
	test("non-roundtable channel → unchanged", () => {
		const r = resolveRoundtableInboundChatId(
			{ channelId: "other", messageId: "M", isThread: false, parentId: null },
			cfgOn,
		);
		expect(r.chatId).toBe("other");
		expect(r.routedToThread).toBe(false);
	});
	test("replyInThread OFF → top-level roundtable unchanged (byte-compat)", () => {
		const r = resolveRoundtableInboundChatId(
			{ channelId: RT, messageId: "M1", isThread: false, parentId: null },
			{ ...cfgOn, replyInThread: false },
		);
		expect(r.chatId).toBe(RT);
		expect(r.routedToThread).toBe(false);
	});
});

describe("decideTopicThreadHandling — self-skip & membership fail-closed", () => {
	test("own message → never handle (self-skip)", () => {
		const store = createThreadBudgetStore();
		const d = decideTopicThreadHandling(
			{ threadId: "T", authorIsSelf: true, authorIsBot: true, isExplicitMention: true, authorIsHuman: false, isMember: true },
			store,
			cfgOn,
		);
		expect(d.handle).toBe(false);
	});
	test("membership unknown → fail-closed: only handle on explicit mention, no relax", () => {
		const store = createThreadBudgetStore();
		// bot author, NOT explicitly mentioned, membership unknown → drop
		const d = decideTopicThreadHandling(
			{ threadId: "T", authorIsSelf: false, authorIsBot: true, isExplicitMention: false, authorIsHuman: false, isMember: undefined },
			store,
			cfgOn,
		);
		expect(d.handle).toBe(false);
	});
	test("non-member bot message (no @) → drop (only members auto-continue)", () => {
		const store = createThreadBudgetStore();
		const d = decideTopicThreadHandling(
			{ threadId: "T", authorIsSelf: false, authorIsBot: true, isExplicitMention: false, authorIsHuman: false, isMember: false },
			store,
			cfgOn,
		);
		expect(d.handle).toBe(false);
	});
});

describe("decideTopicThreadHandling — bounded bot-only budget (Codex R1#1 core)", () => {
	test("member bot message (no @) consumes budget; stops after N", () => {
		const store = createThreadBudgetStore();
		const input = { threadId: "T", authorIsSelf: false, authorIsBot: true, isExplicitMention: false, authorIsHuman: false, isMember: true };
		// budgetN=2 → 2 auto-continues then stop
		expect(decideTopicThreadHandling(input, store, cfgOn).handle).toBe(true);
		expect(decideTopicThreadHandling(input, store, cfgOn).handle).toBe(true);
		expect(decideTopicThreadHandling(input, store, cfgOn).handle).toBe(false); // budget exhausted
	});

	test("bot @-mention does NOT bypass/reset budget — still consumes, still stops", () => {
		const store = createThreadBudgetStore();
		// bot author WITH explicit mention of us — must still be budget-gated
		const input = { threadId: "T", authorIsSelf: false, authorIsBot: true, isExplicitMention: true, authorIsHuman: false, isMember: true };
		expect(decideTopicThreadHandling(input, store, cfgOn).handle).toBe(true);
		expect(decideTopicThreadHandling(input, store, cfgOn).handle).toBe(true);
		expect(decideTopicThreadHandling(input, store, cfgOn).handle).toBe(false); // bot @ cannot revive
	});

	test("non-bot HUMAN message resets budget; bot can continue again", () => {
		const store = createThreadBudgetStore();
		const bot = { threadId: "T", authorIsSelf: false, authorIsBot: true, isExplicitMention: false, authorIsHuman: false, isMember: true };
		decideTopicThreadHandling(bot, store, cfgOn); // 2→1
		decideTopicThreadHandling(bot, store, cfgOn); // 1→0
		expect(decideTopicThreadHandling(bot, store, cfgOn).handle).toBe(false); // exhausted
		// human (non-bot) speaks → reset
		const human = { threadId: "T", authorIsSelf: false, authorIsBot: false, isExplicitMention: false, authorIsHuman: true, isMember: true };
		decideTopicThreadHandling(human, store, cfgOn);
		// bot can continue again for N more
		expect(decideTopicThreadHandling(bot, store, cfgOn).handle).toBe(true);
	});

	test("2-bot adversarial: A and B always @ each other → total auto-continues bounded, then stops", () => {
		// Simulate THIS bot (A) receiving B's messages, B always @-mentions A.
		const store = createThreadBudgetStore();
		const fromB = { threadId: "T", authorIsSelf: false, authorIsBot: true, isExplicitMention: true, authorIsHuman: false, isMember: true };
		let handled = 0;
		for (let i = 0; i < 50; i++) {
			if (decideTopicThreadHandling(fromB, store, cfgOn).handle) handled++;
		}
		// bounded by budgetN regardless of how many times B mentions A
		expect(handled).toBe(cfgOn.budgetN);
	});

	test("per-thread isolation: budget is independent per thread", () => {
		const store = createThreadBudgetStore();
		const bot = (tid: string) => ({ threadId: tid, authorIsSelf: false, authorIsBot: true, isExplicitMention: false, authorIsHuman: false, isMember: true });
		decideTopicThreadHandling(bot("T1"), store, cfgOn); // T1: 2→1
		decideTopicThreadHandling(bot("T1"), store, cfgOn); // T1: 1→0
		expect(decideTopicThreadHandling(bot("T1"), store, cfgOn).handle).toBe(false); // T1 exhausted
		expect(decideTopicThreadHandling(bot("T2"), store, cfgOn).handle).toBe(true);  // T2 fresh
	});

	test("autoContinue OFF (kill-switch) → falls back to mention-required (byte-compat)", () => {
		const store = createThreadBudgetStore();
		const cfg = { ...cfgOn, autoContinue: false };
		// no @ → drop (no relax)
		expect(
			decideTopicThreadHandling({ threadId: "T", authorIsSelf: false, authorIsBot: true, isExplicitMention: false, authorIsHuman: false, isMember: true }, store, cfg).handle,
		).toBe(false);
		// explicit @ → handle (existing mention-gate behavior, NOT budget-gated when autoContinue off)
		expect(
			decideTopicThreadHandling({ threadId: "T", authorIsSelf: false, authorIsBot: true, isExplicitMention: true, authorIsHuman: false, isMember: true }, store, cfg).handle,
		).toBe(true);
	});
});
