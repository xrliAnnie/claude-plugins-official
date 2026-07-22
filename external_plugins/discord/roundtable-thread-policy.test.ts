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
	shouldProbeTopicThreadMembership,
	shouldSeedInitiatorBudget,
	classifyThreadCreate,
	threadGetConfirmsExistence,
	confirmThreadUnderParent,
	buildRoundtableThreadCreateBody,
	deriveRoundtableThreadName,
	isTopicNoise,
	rememberRoundtableRedirect,
	resolveAutoArchiveMinutes,
	shouldStripRoundtableReplyTo,
	DEFAULT_ROUNDTABLE_THREAD_BUDGET,
	type RoundtableConfig,
} from "./roundtable-thread-policy";

const RT = "1512578695468941333"; // roundtable parent channel id
const cfgOn: RoundtableConfig = {
	channelId: RT,
	replyInThread: true,
	autoContinue: true,
	budgetN: 2,
};
// FLY-676: production-shape config (member-follow on, default budget 12).
const cfgOn12: RoundtableConfig = {
	channelId: RT,
	replyInThread: true,
	autoContinue: true,
	budgetN: DEFAULT_ROUNDTABLE_THREAD_BUDGET,
};

describe("loadRoundtableConfig", () => {
	test("nothing set (no env channel, no routing) → undefined (byte-compat OFF)", () => {
		expect(loadRoundtableConfig({})).toBeUndefined();
		expect(loadRoundtableConfig({}, {})).toBeUndefined();
	});
	test("FLY-569/FLY-676: env channel id without flags → reply routing + autoContinue DEFAULT-ON", () => {
		const c = loadRoundtableConfig({ FLYWHEEL_ROUNDTABLE_CHANNEL_ID: RT });
		expect(c?.channelId).toBe(RT);
		expect(c?.replyInThread).toBe(true); // was false pre-FLY-569 — now default-on
		expect(c?.autoContinue).toBe(true); // FLY-676: member-follow now default-on (was false)
		expect(c?.budgetN).toBe(12); // FLY-676: default budget 2 → 12
	});
	test("FLY-676: explicit opt-out THREAD_AUTOCONTINUE=0 → kill-switch (mention-required)", () => {
		const c = loadRoundtableConfig({
			FLYWHEEL_ROUNDTABLE_CHANNEL_ID: RT,
			FLYWHEEL_ROUNDTABLE_THREAD_AUTOCONTINUE: "0",
		});
		expect(c?.replyInThread).toBe(true);
		expect(c?.autoContinue).toBe(false);
	});
	test("FLY-676: explicit THREAD_BUDGET overrides the default 12", () => {
		const c = loadRoundtableConfig({
			FLYWHEEL_ROUNDTABLE_CHANNEL_ID: RT,
			FLYWHEEL_ROUNDTABLE_THREAD_BUDGET: "5",
		});
		expect(c?.budgetN).toBe(5);
	});
	test("FLY-569: explicit opt-out REPLY_IN_THREAD=0 → reply routing OFF", () => {
		const c = loadRoundtableConfig({
			FLYWHEEL_ROUNDTABLE_CHANNEL_ID: RT,
			FLYWHEEL_ROUNDTABLE_REPLY_IN_THREAD: "0",
		});
		expect(c?.channelId).toBe(RT);
		expect(c?.replyInThread).toBe(false);
	});
	test("FLY-569/FLY-676: routing channel only (env empty) → channelId from routing + reply+autoContinue default-on (Belle path)", () => {
		const c = loadRoundtableConfig({}, { channelId: RT });
		expect(c?.channelId).toBe(RT);
		expect(c?.replyInThread).toBe(true);
		expect(c?.autoContinue).toBe(true); // FLY-676: default-on
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

describe("decideTopicThreadHandling — FLY-576 non-bot (founder) relaxation, DEFAULT-ON", () => {
	const cfgOff = { ...cfgOn, autoContinue: false }; // production: reply-in-thread on, autoContinue off

	test("human MEMBER, no @, autoContinue OFF → handle (THE FIX: founder surfaces without @)", () => {
		const store = createThreadBudgetStore();
		const d = decideTopicThreadHandling(
			{ threadId: "T", authorIsSelf: false, authorIsBot: false, authorIsHuman: true, isExplicitMention: false, isMember: true },
			store,
			cfgOff,
		);
		expect(d.handle).toBe(true);
	});

	test("human NON-member, no @, autoContinue OFF → drop (still needs @ when not a member)", () => {
		const store = createThreadBudgetStore();
		const d = decideTopicThreadHandling(
			{ threadId: "T", authorIsSelf: false, authorIsBot: false, authorIsHuman: true, isExplicitMention: false, isMember: false },
			store,
			cfgOff,
		);
		expect(d.handle).toBe(false);
	});

	test("human NON-member, explicit @, autoContinue OFF → handle (explicit @ always works)", () => {
		const store = createThreadBudgetStore();
		const d = decideTopicThreadHandling(
			{ threadId: "T", authorIsSelf: false, authorIsBot: false, authorIsHuman: true, isExplicitMention: true, isMember: false },
			store,
			cfgOff,
		);
		expect(d.handle).toBe(true);
	});

	test("human member message resets the bot budget even with autoContinue OFF", () => {
		const store = createThreadBudgetStore();
		decideTopicThreadHandling(
			{ threadId: "T", authorIsSelf: false, authorIsBot: false, authorIsHuman: true, isExplicitMention: false, isMember: true },
			store,
			cfgOff,
		);
		expect(store.budgets.get("T")).toBe(cfgOff.budgetN);
	});

	test("human member, no @, autoContinue ON → still handle (unchanged)", () => {
		const store = createThreadBudgetStore();
		const d = decideTopicThreadHandling(
			{ threadId: "T", authorIsSelf: false, authorIsBot: false, authorIsHuman: true, isExplicitMention: false, isMember: true },
			store,
			cfgOn,
		);
		expect(d.handle).toBe(true);
	});

	test("bot path UNCHANGED by the non-bot relaxation: bot member no @ autoContinue OFF → drop (no melee)", () => {
		const store = createThreadBudgetStore();
		const d = decideTopicThreadHandling(
			{ threadId: "T", authorIsSelf: false, authorIsBot: true, authorIsHuman: false, isExplicitMention: false, isMember: true },
			store,
			cfgOff,
		);
		expect(d.handle).toBe(false);
	});
});

describe("shouldProbeTopicThreadMembership (FLY-576 R1#1 — pure probe-decision seam)", () => {
	test("non-bot, no @ → probe (FLY-576 founder path needs membership)", () => {
		expect(shouldProbeTopicThreadMembership({ authorIsBot: false, isExplicitMention: false, autoContinue: false })).toBe(true);
	});
	test("non-bot, explicit @ → skip probe (decided by isExplicitMention; avoid 5s timeout)", () => {
		expect(shouldProbeTopicThreadMembership({ authorIsBot: false, isExplicitMention: true, autoContinue: false })).toBe(false);
	});
	test("bot, autoContinue OFF → skip probe (bot is mention-only, membership unused)", () => {
		expect(shouldProbeTopicThreadMembership({ authorIsBot: true, isExplicitMention: false, autoContinue: false })).toBe(false);
		expect(shouldProbeTopicThreadMembership({ authorIsBot: true, isExplicitMention: true, autoContinue: false })).toBe(false);
	});
	test("bot, autoContinue ON → probe (budget path needs membership)", () => {
		expect(shouldProbeTopicThreadMembership({ authorIsBot: true, isExplicitMention: false, autoContinue: true })).toBe(true);
	});
});

describe("FLY-676 — member-follow default-on + non-member @ semantics", () => {
	test("member bot, no @, autoContinue ON, budget seeded to default 12 → follows up to 12 then stops", () => {
		const store = createThreadBudgetStore();
		seedThreadBudget(store, "T", DEFAULT_ROUNDTABLE_THREAD_BUDGET);
		const bot = { threadId: "T", authorIsSelf: false, authorIsBot: true, authorIsHuman: false, isExplicitMention: false, isMember: true };
		let handled = 0;
		for (let i = 0; i < 100; i++) {
			if (decideTopicThreadHandling(bot, store, cfgOn12).handle) handled++;
		}
		expect(handled).toBe(DEFAULT_ROUNDTABLE_THREAD_BUDGET); // 12 no-@ continuations, then mention-required
	});

	test("non-member bot + explicit @ → handle (one reply; top-level @ semantics, NOT dropped)", () => {
		const store = createThreadBudgetStore();
		const d = decideTopicThreadHandling(
			{ threadId: "T", authorIsSelf: false, authorIsBot: true, authorIsHuman: false, isExplicitMention: true, isMember: false },
			store,
			cfgOn12,
		);
		expect(d.handle).toBe(true);
		expect(store.budgets.has("T")).toBe(false); // non-member @ is NOT budget-tracked (unbudgeted, like top-level)
	});

	test("non-member bot, no @ → drop (never drawn into a thread without an @)", () => {
		const store = createThreadBudgetStore();
		expect(
			decideTopicThreadHandling({ threadId: "T", authorIsSelf: false, authorIsBot: true, authorIsHuman: false, isExplicitMention: false, isMember: false }, store, cfgOn12).handle,
		).toBe(false);
	});

	test("unknown membership + explicit @ → handle (top-level @ semantics); + no @ → drop (no relax without proof)", () => {
		const store = createThreadBudgetStore();
		expect(
			decideTopicThreadHandling({ threadId: "T", authorIsSelf: false, authorIsBot: true, authorIsHuman: false, isExplicitMention: true, isMember: undefined }, store, cfgOn12).handle,
		).toBe(true);
		expect(
			decideTopicThreadHandling({ threadId: "T", authorIsSelf: false, authorIsBot: true, authorIsHuman: false, isExplicitMention: false, isMember: undefined }, store, cfgOn12).handle,
		).toBe(false);
	});

	test("member bot, UNSEEDED budget (initiator pre-seed), explicit @ → drop (missing = exhausted, @ does not revive)", () => {
		const store = createThreadBudgetStore();
		// proves the safe side: a member with no seeded budget drops even an explicit @ (restart/replay safety).
		expect(
			decideTopicThreadHandling({ threadId: "T", authorIsSelf: false, authorIsBot: true, authorIsHuman: false, isExplicitMention: true, isMember: true }, store, cfgOn12).handle,
		).toBe(false);
	});
});

describe("shouldSeedInitiatorBudget (FLY-676 — initiator-seed pure seam)", () => {
	test("send to roundtable parent + autoContinue ON → seed", () => {
		expect(shouldSeedInitiatorBudget({ sentToChannelId: RT, cfg: cfgOn12 })).toBe(true);
	});
	test("send to a non-parent channel → never seed (only top-level topic posts)", () => {
		expect(shouldSeedInitiatorBudget({ sentToChannelId: "other", cfg: cfgOn12 })).toBe(false);
	});
	test("autoContinue OFF (kill-switch) → never seed", () => {
		expect(shouldSeedInitiatorBudget({ sentToChannelId: RT, cfg: { ...cfgOn12, autoContinue: false } })).toBe(false);
	});
});

describe("resolveRoundtableInboundChatId — FLY-314 fix (follow-up + noise + naming)", () => {
	test("fresh topic → routed to its own thread, create-or-confirm, descriptive threadName", () => {
		const r = resolveRoundtableInboundChatId(
			{
				channelId: RT,
				messageId: "M1",
				isThread: false,
				parentId: null,
				content: "<@1> deploy plan sync",
			},
			cfgOn,
		);
		expect(r.chatId).toBe("M1");
		expect(r.sourceMessageId).toBe("M1");
		expect(r.routedToThread).toBe(true);
		expect(r.confirmOnly).toBeFalsy();
		expect(r.threadName).toBe("deploy plan sync");
	});

	test("follow-up (Discord reply) → confirm-only route INTO the referenced thread, no new thread", () => {
		const r = resolveRoundtableInboundChatId(
			{
				channelId: RT,
				messageId: "M2",
				isThread: false,
				parentId: null,
				referencedMessageId: "M1",
				content: "agreed, ship it",
			},
			cfgOn,
		);
		expect(r.chatId).toBe("M1"); // routes into the referenced topic thread
		expect(r.sourceMessageId).toBe("M1");
		expect(r.routedToThread).toBe(true);
		expect(r.confirmOnly).toBe(true); // GET-verify only, never create
	});

	test("noise (pure emoji) fresh top-level → NOT routed to a thread (reply stays in parent)", () => {
		for (const content of ["👍👍", "🎉", "<:tada:1>", "ok"]) {
			const r = resolveRoundtableInboundChatId(
				{ channelId: RT, messageId: "M3", isThread: false, parentId: null, content },
				cfgOn,
			);
			expect(r.chatId).toBe(RT);
			expect(r.routedToThread).toBe(false);
		}
	});

	test("byte-compat: top-level with no content/ref still routes to its thread (no confirmOnly)", () => {
		const r = resolveRoundtableInboundChatId(
			{ channelId: RT, messageId: "M1", isThread: false, parentId: null },
			cfgOn,
		);
		expect(r.chatId).toBe("M1");
		expect(r.routedToThread).toBe(true);
		expect(r.confirmOnly).toBeFalsy();
	});
});

describe("deriveRoundtableThreadName / isTopicNoise / confirmThreadUnderParent — FLY-314 fix", () => {
	test("deriveRoundtableThreadName strips markup, falls back to placeholder", () => {
		expect(
			deriveRoundtableThreadName("<@1> Flywheel restarted — check runners"),
		).toBe("Flywheel restarted — check runners");
		expect(deriveRoundtableThreadName("<@1> <#2>")).toBe("Roundtable topic");
	});

	test("isTopicNoise: emoji/short = noise, real text = not", () => {
		expect(isTopicNoise("👍👍")).toBe(true);
		expect(isTopicNoise("ok")).toBe(true);
		expect(isTopicNoise("<:tada:1>")).toBe(true);
		expect(isTopicNoise("deploy plan")).toBe(false);
		expect(isTopicNoise("重启了")).toBe(false);
	});

	test("confirmThreadUnderParent: only a thread type under the right parent confirms", () => {
		expect(confirmThreadUnderParent({ type: 11, parent_id: RT }, RT)).toBe(true);
		expect(confirmThreadUnderParent({ type: 0, parent_id: RT }, RT)).toBe(false); // not a thread
		expect(confirmThreadUnderParent({ type: 11, parent_id: "other" }, RT)).toBe(false); // wrong parent
		expect(confirmThreadUnderParent(null, RT)).toBe(false);
	});
});

describe("roundtable topic archive policy — FLY-802", () => {
	test("resolves supported Discord channel defaults and falls back to 3 days", () => {
		for (const minutes of [60, 1440, 4320, 10080]) {
			expect(resolveAutoArchiveMinutes(minutes)).toBe(minutes);
		}
		expect(resolveAutoArchiveMinutes(null)).toBe(4320);
		expect(resolveAutoArchiveMinutes(undefined)).toBe(4320);
		expect(resolveAutoArchiveMinutes(30)).toBe(4320);
	});

	test("builds the create body from the descriptive name and parent default", () => {
		expect(buildRoundtableThreadCreateBody("Deploy rollback plan", 60)).toEqual({
			name: "Deploy rollback plan",
			auto_archive_duration: 60,
		});
		expect(buildRoundtableThreadCreateBody(undefined, null)).toEqual({
			name: "Roundtable topic",
			auto_archive_duration: 4320,
		});
	});
});

describe("rememberRoundtableRedirect / shouldStripRoundtableReplyTo — FLY-314 fix (bounded, testable)", () => {
	test("remembers BOTH the topic source id and the follow-up id; strip matches either", () => {
		const map = new Map<string, Set<string>>();
		rememberRoundtableRedirect(map, "T1", ["root", "followup"], {
			maxThreads: 10,
			maxPerThread: 10,
		});
		expect(shouldStripRoundtableReplyTo(map, "T1", "root")).toBe(true);
		expect(shouldStripRoundtableReplyTo(map, "T1", "followup")).toBe(true);
		expect(shouldStripRoundtableReplyTo(map, "T1", "other")).toBe(false);
		expect(shouldStripRoundtableReplyTo(map, "T1", undefined)).toBe(false);
		expect(shouldStripRoundtableReplyTo(map, "unknown", "root")).toBe(false);
	});

	test("bounds the ids PER hot thread (oldest evicted) — Codex R1 MEDIUM", () => {
		const map = new Map<string, Set<string>>();
		for (let i = 0; i < 100; i++)
			rememberRoundtableRedirect(map, "T1", [`id${i}`], {
				maxThreads: 10,
				maxPerThread: 3,
			});
		expect(map.get("T1")!.size).toBe(3);
		expect(shouldStripRoundtableReplyTo(map, "T1", "id0")).toBe(false); // evicted
		expect(shouldStripRoundtableReplyTo(map, "T1", "id99")).toBe(true); // newest kept
	});

	test("bounds the number of threads (oldest thread evicted)", () => {
		const map = new Map<string, Set<string>>();
		for (let i = 0; i < 100; i++)
			rememberRoundtableRedirect(map, `T${i}`, ["x"], {
				maxThreads: 5,
				maxPerThread: 10,
			});
		expect(map.size).toBe(5);
	});

	test("skips empty ids", () => {
		const map = new Map<string, Set<string>>();
		rememberRoundtableRedirect(map, "T1", ["", "real"], {
			maxThreads: 10,
			maxPerThread: 10,
		});
		expect(map.get("T1")!.has("real")).toBe(true);
		expect(map.get("T1")!.size).toBe(1);
	});
});
