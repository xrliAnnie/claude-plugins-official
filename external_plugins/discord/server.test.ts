import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { roundtableParentReplyHint } from "./roundtable-thread-policy";
import { SelfAuthorFilter, attachSelfAuthorFilter } from "./self-author-filter";
import { createIntakePipeline } from "./inbound-catchup";

// Exercise the real server functions without opening Discord or the MCP process.
const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
const start = source.indexOf("async function ensureRoundtableThread(");
const body = source.slice(start, source.indexOf("\n}", start) + 2);
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(body);

describe("choice A server wiring", () => {
  test("human parent topics include the source reply reference instruction in model input", () => {
    const start = source.indexOf("  const originalContent = msg.content");
    const snippet = source.slice(start, source.indexOf("\n  const inboundMeta", start));
    const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(snippet);
    const render = new Function("msg", "atts", "RT_CFG", "roundtableParentReplyHint", `${compiled}; return content`);
    const message = { id: "123", channelId: "parent", content: "Original founder topic", author: { bot: false }, reference: null, channel: { isThread: () => false } };
    expect(render(message, [], { channelId: "parent", replyInThread: true }, roundtableParentReplyHint)).toContain("reply_to=123");
    expect(render({ ...message, author: { bot: true } }, [], { channelId: "parent", replyInThread: true }, roundtableParentReplyHint)).toBe(message.content);
  });
  test.each(["off", "first", "all"])("roundtable parent references override reply mode %s with strict all-chunk options", async replyToMode => {
    const start = source.indexOf("        const strictParentReply =");
    const stop = source.indexOf("          replyRetryOpts,", start) + "          replyRetryOpts,".length;
    const snippet = source.slice(start, stop) + "\n); return sentIds";
    const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(`async function options() { ${snippet} }`);
    const build = new Function("RT_CFG", "chat_id", "reply_to", "access", "chunk", "text", "limit", "mode", "sendReplyChunks", "files", "replyRetryOpts", `${compiled}; return options`);
    const options = (channel: string) => build({ channelId: "parent" }, channel, "123", { replyToMode }, () => ["a", "b"], "text", 1900, "length", async (_send: unknown, _chunks: unknown, opts: unknown) => opts, [], {})();
    expect(await options("parent")).toMatchObject({ replyMode: "all", reply_to: "123", failIfNotExists: true });
    expect(await options("other")).toMatchObject({ replyMode: replyToMode });
    expect(await options("other")).not.toHaveProperty("failIfNotExists");
  });
});

function ensureFixture(foundAt: number, confirmOnly = false, slow = false, token = "token") {
  let probes = 0;
  let elapsed = 0;
  let creates = 0;
  const signals: AbortSignal[] = [];
  const build = new Function("TOKEN", "roundtableThreadExists", "RT_GET_CONFIRM_RETRIES",
    "RT_GET_CONFIRM_DELAY_MS", "fetch", "RT_DISCORD_API",
    "process", "setTimeout", "performance", `${compiled}; return ensureRoundtableThread`);
  const ensure = build(token, async (_id: string, _parent: string, timeout?: number) => {
    probes++;
    if (slow) elapsed += timeout ?? 5000;
    return probes === foundAt;
  }, Number(source.match(/const RT_GET_CONFIRM_RETRIES = (\d+)/)![1]),
  Number(source.match(/const RT_GET_CONFIRM_DELAY_MS = (\d+)/)![1]),
  async (_url: string, init: RequestInit) => {
    creates++;
    signals.push(init.signal!);
    return { status: 201 };
  }, "https://discord.com/api/v10", { stderr: { write() {} } },
  (callback: () => void, delay: number) => { elapsed += delay; callback(); }, { now: () => elapsed });
  return { run: () => ensure("parent", "message", { confirmOnly }),
    counts: () => ({ probes, elapsed, creates, signals }) };
}

describe("FLY-3698 host-first server routing", () => {
  test("host creates on second confirmation: Lead never POSTs", async () => {
    const fixture = ensureFixture(2);
    expect(await fixture.run()).toBe(true);
    expect(fixture.counts().creates).toBe(0);
    expect(fixture.counts().probes).toBe(2);
  });
  test("host absent: recipient never creates after the confirmation window", async () => {
    const fixture = ensureFixture(-1);
    expect(await fixture.run()).toBe(false);
    expect(fixture.counts().probes).toBe(12);
    expect(fixture.counts().creates).toBe(0);
    expect(fixture.counts().elapsed).toBe(5500);
  });
  test("follow-up uses the same window but never creates", async () => {
    const fixture = ensureFixture(-1, true);
    expect(await fixture.run()).toBe(false);
    expect(fixture.counts().probes).toBe(12);
    expect(fixture.counts().creates).toBe(0);
  });
  test("slow confirmation is bounded by 6000ms without creating", async () => {
    const fixture = ensureFixture(-1, false, true);
    expect(await fixture.run()).toBe(false);
    expect(fixture.counts().elapsed).toBeLessThanOrEqual(6000);
    expect(fixture.counts().creates).toBe(0);
  });
  test("host starting after timeout can be confirmed on a later retry", async () => {
    const fixture = ensureFixture(14);
    expect(await fixture.run()).toBe(false);
    expect(await fixture.run()).toBe(true);
    expect(fixture.counts().creates).toBe(0);
  });
  test("concurrent recipients only confirm an already-started host", async () => {
    const a = ensureFixture(1);
    const b = ensureFixture(1);
    expect(await Promise.all([a.run(), b.run()])).toEqual([true, true]);
    expect(a.counts().creates + b.counts().creates).toBe(0);
  });
  test("a host starting at the final probe is used without creating", async () => {
    const fixture = ensureFixture(12);
    expect(await fixture.run()).toBe(true);
    expect(fixture.counts().probes).toBe(12);
    expect(fixture.counts().creates).toBe(0);
  });
  test("missing credentials cannot create or probe", async () => {
    const fixture = ensureFixture(-1, false, false, "");
    expect(await fixture.run()).toBe(false);
    expect(fixture.counts().probes).toBe(0);
    expect(fixture.counts().creates).toBe(0);
  });
  test.each(["ready", "shardReconnecting"])("real self-filter wiring keeps system/self/disallowed messages out during %s", async lifecycle => {
    const callbackStart = source.indexOf("function catchupLiveRef(");
    expect(callbackStart).toBeGreaterThanOrEqual(0);
    const stop = source.indexOf("\n// Returns 'done' once", callbackStart);
    expect(stop).toBeGreaterThan(callbackStart);
    const code = new Bun.Transpiler({ loader: "ts" }).transformSync(source.slice(callbackStart, stop));
    const self = "100000000000000001";
    const lead = "100000000000000002";
    const client = Object.assign(new EventEmitter(), { user: { id: self }, isReady: () => true });
    const filter = new SelfAuthorFilter();
    const inbound: unknown[] = [];
    const echoes: string[] = [];
    const tracked: string[] = [];
    const catchup = {
      noteLive(ref: { channelId: string }) { tracked.push(`live:${ref.channelId}`); },
      noteDone(_channel: string, id: string) { tracked.push(`done:${id}`); },
      begin(_channel: string, id: string, live: boolean) { tracked.push(`begin:${id}:${live}`); },
      finish(_channel: string, id: string, outcome: string) { tracked.push(`finish:${id}:${outcome}`); },
    };
    const intake = createIntakePipeline({
      tracker: catchup,
      allowBots: () => [lead, self],
      identityValid: () => filter.identityValid(),
      allowsIntake: (id: string) => filter.allowsIntake(id),
      handle: async (msg: unknown) => { inbound.push(msg); return "done" as const; },
      log() {},
    });
    new Function("client", "selfAuthorFilter", "attachSelfAuthorFilter", "gatewayHealth", "gatewayHealthFiles", "inboundCatchup", "inboundIntake", code)(
      client, filter, attachSelfAuthorFilter,
      { onSelfEcho(id: string) { echoes.push(id); } }, { log() {} }, catchup, intake);
    const emit = (id: string, system: boolean, authorId = lead, bot = true) => {
      const msg = { id, channelId: "channel", system, author: { id: authorId, bot } };
      client.emit("messageCreate", msg);
      return msg;
    };
    emit("before-ready", false);
    expect(inbound).toEqual([]);
    client.emit("ready");
    if (lifecycle !== "ready") client.emit(lifecycle);
    emit("system", true);
    emit("disallowed", false, "100000000000000003");
    emit("unknown", false, "");
    emit("self-normal", false, self);
    emit("self-system", true, self);
    expect(inbound).toEqual([]);
    expect(echoes).toEqual(["self-normal", "self-system"]);
    const allowed = emit("allowed", false);
    await Promise.resolve();
    expect(inbound).toEqual([allowed]);
    const human = emit("human", false, "100000000000000004", false);
    await Promise.resolve();
    expect(inbound).toEqual([allowed, human]);
    // FLY-5394: self echoes and every admitted message are tracked for catch-up.
    expect(tracked).toContain("done:self-normal");
    expect(tracked).toContain("begin:allowed:true");
    expect(tracked).toContain("finish:allowed:done");
    expect(tracked.filter(t => t.startsWith("finish:system"))).toEqual(["finish:system:done"]);
  });
});

describe("FLY-5394 inbound catch-up server wiring", () => {
  const between = (from: string, to: string) => {
    const start = source.indexOf(from);
    expect(start).toBeGreaterThanOrEqual(0);
    const stop = source.indexOf(to, start);
    expect(stop).toBeGreaterThan(start);
    return source.slice(start, stop);
  };

  test("T18 the startup window is constructed at module load before client.login, only outside disabled mode", () => {
    const construct = source.indexOf("new InboundCatchup<Message>(");
    expect(construct).toBeGreaterThan(0);
    expect(construct).toBeLessThan(source.indexOf("await mcp.connect("));
    expect(construct).toBeLessThan(source.indexOf("client.login(TOKEN)"));
    expect(source).toContain("const inboundCatchup: InboundCatchup<Message> | undefined = RECORDER_MODE.kind === 'disabled'\n  ? undefined");
  });

  test("T18 lifecycle and raw events reach the catch-up; messageCreate stays a single listener", () => {
    const wiring = between("if (inboundCatchup) {", "inboundCatchupEvidence.unref");
    for (const event of ["shardReady", "shardResume"]) {
      expect(wiring).toContain(`client.on('${event}', () => { inboundCatchup.onConnected() })`);
    }
    for (const event of ["shardReconnecting", "shardDisconnect", "invalidated"]) {
      expect(wiring).toContain(`client.on('${event}', () => { inboundCatchup.onDisconnected() })`);
    }
    expect(wiring).toContain("client.on('raw', (packet: unknown) => { inboundCatchup.noteRaw(packet) })");
    expect(wiring).toContain("if (!selfAuthorFilter.identityValid()) return");
    // The only messageCreate listener stays inside attachSelfAuthorFilter (FLY-2598).
    expect(source).not.toMatch(/\.on\(\s*['"]messageCreate/);
    expect(source.match(/attachSelfAuthorFilter<Message>\(/g) ?? []).toHaveLength(1);
    expect(source).toContain("onOther: msg => {\n    inboundCatchup?.noteLive(catchupLiveRef(msg))\n    void inboundIntake.intake(msg, 'live')");
    expect(between("function shutdown(): void {", "process.stdin.on('end'")).toContain("inboundCatchup?.shutdown()");
  });

  test("T18 handleInbound reports durability for both mailbox and held (broken) delivery", () => {
    const body = between("async function handleInbound(msg: Message, origin: 'live' | 'catchup')", "\nclient.once('ready'");
    expect(body).toContain("const outcome: IntakeOutcome = accepted.durable ? 'done' : 'failed'");
    expect(body).toContain("if (result.action === 'drop') return 'done'");
    expect(between("if (delivery === 'rejected') {", "// Typing keepalive")).toContain("return outcome");
    expect(body.trimEnd().endsWith("return outcome\n}")).toBe(true);
  });

  test("T11 a caught-up permission reply for an unknown request is delivered as a normal message", () => {
    const line = source.split("\n").find(l => l.includes("if (permMatch &&"))!;
    const condition = line.trim().replace(/^if \(/, "").replace(/\) \{$/, "").replaceAll("]!.", "].");
    const decide = new Function("permMatch", "origin", "pendingPermissions", `return ${condition}`);
    const match = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i.exec("yes abcde");
    expect(decide(match, "live", new Map())).toBe(true);
    expect(decide(match, "catchup", new Map())).toBe(false);
    expect(decide(match, "catchup", new Map([["abcde", {}]]))).toBe(true);
    expect(decide(null, "live", new Map())).toBeFalsy();
  });

  test("T20 channel metadata is always read with force so a stale cache cannot hide new messages", () => {
    const adapter = between("function inboundCatchupDiscord()", "\nconst inboundCatchup");
    expect(adapter).toContain("client.channels.fetch(id, { force: true })");
    expect(adapter).toContain("fetchArchived({\n        type: 'public',\n        limit: 100,");
    expect(adapter).toContain("ch.messages.fetch({ after, limit, cache: false })");
  });
});
