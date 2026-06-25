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
	seedThreadBudget,
	classifyThreadCreate,
	threadGetConfirmsExistence,
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
	test("nothing set (no env channel, no routing) → undefined (byte-compat OFF)", () => {
		expect(loadRoundtableConfig({})).toBeUndefined();
		expect(loadRoundtableConfig({}, {})).toBeUndefined();
	});
	test("FLY-569: env channel id without reply flag → reply routing DEFAULT-ON", () => {
		const c = loadRoundtableConfig({ FLYWHEEL_ROUNDTABLE_CHANNEL_ID: RT });
		expect(c?.channelId).toBe(RT);
		expect(c?.replyInThread).toBe(true); // was false pre-FLY-569 — now default-on
		expect(c?.autoContinue).toBe(false); // anti-loop stays default-off
	});
	test("FLY-569: explicit opt-out REPLY_IN_THREAD=0 → reply routing OFF", () => {
		const c = loadRoundtableConfig({
			FLYWHEEL_ROUNDTABLE_CHANNEL_ID: RT,
			FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD: "0",
		});
		expect(c?.channelId).toBe(RT);
		expect(c?.replyInThread).toBe(false);
	});
	test("FLY-569: routing channel only (env empty) → channelId from routing + default-on (Belle path)", () => {
		const c = loadRoundtableConfig({}, { channelId: RT });
		expect(c?.channelId).toBe(RT);
		expect(c?.replyInThread).toBe(true);
		expect(c?.autoContinue).toBe(false);
	});
	test("FLY-569: routing channel + explicit opt-out → OFF", () => {
		const c = loadRoundtableConfig(
			{ FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD: "0" },
			{ channelId: RT },
		);
		expect(c?.channelId).toBe(RT);
		expect(c?.replyInThread).toBe(false);
	});
	test("FLY-569: env channel wins over routing channel", () => {
		const c = loadRoundtableConfig(
			{ FLYWHEEL_ROUNDTABLE_CHANNEL_ID: RT },
			{ channelId: "999999999999999999" },
		);
		expect(c?.channelId).toBe(RT); // env wins
	});
	test("full enable (explicit =1 still works)", () => {
		const c = loadRoundtableConfig({
			FLYWHEEL_ROUNDTABLE_CHANNEL_ID: RT,
			FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD: "1",
			FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE: "1",
		});
		expect(c?.replyInThread).toBe(true);
		expect(c?.autoContinue).toBe(true);
	});
	test("reply flag set but no channel id anywhere → undefined (can't identify roundtable)", () => {
		expect(
			loadRoundtableConfig({ FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD: "1" }),
		).toBeUndefined();
		expect(
			loadRoundtableConfig({ FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD: "1" }, {}),
		).toBeUndefined();
	});
});

describe("classifyThreadCreate / threadGetConfirmsExistence (FLY-569 R1#2)", () => {
	test("2xx create → created", () => {
		expect(classifyThreadCreate(201)).toBe("created");
		expect(classifyThreadCreate(200)).toBe("created");
	});
	test("400/409 with code 160004 (already has thread) → exists", () => {
		expect(classifyThreadCreate(400, 160004)).toBe("exists");
		expect(classifyThreadCreate(409, 160004)).toBe("exists");
	});
	test("403/404/429/5xx → confirm-via-get (maybe host/Bridge already created it)", () => {
		expect(classifyThreadCreate(403)).toBe("confirm-via-get");
		expect(classifyThreadCreate(404)).toBe("confirm-via-get");
		expect(classifyThreadCreate(429)).toBe("confirm-via-get");
		expect(classifyThreadCreate(500)).toBe("confirm-via-get");
		expect(classifyThreadCreate(503)).toBe("confirm-via-get");
	});
	test("other 4xx (e.g. 400 without 160004) → failed", () => {
		expect(classifyThreadCreate(400)).toBe("failed");
		expect(classifyThreadCreate(401)).toBe("failed");
	});
	test("threadGetConfirmsExistence: only 200 confirms", () => {
		expect(threadGetConfirmsExistence(200)).toBe(true);
		expect(threadGetConfirmsExistence(404)).toBe(false);
		expect(threadGetConfirmsExistence(403)).toBe(false);
		expect(threadGetConfirmsExistence(500)).toBe(false);
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
	test("UNSEEDED thread: a bot trigger drops (missing budget = exhausted, NOT a reset)", () => {
		const store = createThreadBudgetStore();
		// No seed (e.g. after a process restart) → a bot trigger must NOT get fresh budget.
		const input = { threadId: "T", authorIsSelf: false, authorIsBot: true, isExplicitMention: true, authorIsHuman: false, isMember: true };
		expect(decideTopicThreadHandling(input, store, cfgOn).handle).toBe(false);
	});

	test("seeded thread: member bot message (no @) consumes budget; stops after N", () => {
		const store = createThreadBudgetStore();
		seedThreadBudget(store, "T", cfgOn.budgetN); // new top-level topic engage
		const input = { threadId: "T", authorIsSelf: false, authorIsBot: true, isExplicitMention: false, authorIsHuman: false, isMember: true };
		expect(decideTopicThreadHandling(input, store, cfgOn).handle).toBe(true);
		expect(decideTopicThreadHandling(input, store, cfgOn).handle).toBe(true);
		expect(decideTopicThreadHandling(input, store, cfgOn).handle).toBe(false); // budget exhausted
	});

	test("bot @-mention does NOT bypass/reset budget — still consumes, still stops", () => {
		const store = createThreadBudgetStore();
		seedThreadBudget(store, "T", cfgOn.budgetN);
		// bot author WITH explicit mention of us — must still be budget-gated
		const input = { threadId: "T", authorIsSelf: false, authorIsBot: true, isExplicitMention: true, authorIsHuman: false, isMember: true };
		expect(decideTopicThreadHandling(input, store, cfgOn).handle).toBe(true);
		expect(decideTopicThreadHandling(input, store, cfgOn).handle).toBe(true);
		expect(decideTopicThreadHandling(input, store, cfgOn).handle).toBe(false); // bot @ cannot revive
	});

	test("non-bot HUMAN message resets budget; bot can continue again", () => {
		const store = createThreadBudgetStore();
		seedThreadBudget(store, "T", cfgOn.budgetN);
		const bot = { threadId: "T", authorIsSelf: false, authorIsBot: true, isExplicitMention: false, authorIsHuman: false, isMember: true };
		decideTopicThreadHandling(bot, store, cfgOn); // 2→1
		decideTopicThreadHandling(bot, store, cfgOn); // 1→0
		expect(decideTopicThreadHandling(bot, store, cfgOn).handle).toBe(false); // exhausted
		// human (non-bot) speaks → reset (a real reset event, unlike a missing entry)
		const human = { threadId: "T", authorIsSelf: false, authorIsBot: false, isExplicitMention: false, authorIsHuman: true, isMember: true };
		decideTopicThreadHandling(human, store, cfgOn);
		// bot can continue again for N more
		expect(decideTopicThreadHandling(bot, store, cfgOn).handle).toBe(true);
	});

	test("2-bot adversarial: A and B always @ each other → total auto-continues bounded, then stops", () => {
		// Topic seeded ONCE (started once); then THIS bot (A) receives B's messages,
		// B always @-mentions A. Bounded by budgetN regardless of how many B sends.
		const store = createThreadBudgetStore();
		seedThreadBudget(store, "T", cfgOn.budgetN);
		const fromB = { threadId: "T", authorIsSelf: false, authorIsBot: true, isExplicitMention: true, authorIsHuman: false, isMember: true };
		let handled = 0;
		for (let i = 0; i < 50; i++) {
			if (decideTopicThreadHandling(fromB, store, cfgOn).handle) handled++;
		}
		expect(handled).toBe(cfgOn.budgetN);
	});

	test("per-thread isolation: budget is independent per thread", () => {
		const store = createThreadBudgetStore();
		seedThreadBudget(store, "T1", cfgOn.budgetN);
		seedThreadBudget(store, "T2", cfgOn.budgetN);
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
