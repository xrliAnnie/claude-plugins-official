import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Exercise the real server functions without opening Discord or the MCP process.
const source = readFileSync(new URL("./server.ts", import.meta.url), "utf8");
const start = source.indexOf("async function ensureRoundtableThread(");
const body = source.slice(start, source.indexOf("\n}", start) + 2);
const compiled = new Bun.Transpiler({ loader: "ts" }).transformSync(body);

function ensureFixture(foundAt: number, confirmOnly = false, slow = false, token = "token") {
  let probes = 0;
  let elapsed = 0;
  let creates = 0;
  const signals: AbortSignal[] = [];
  const build = new Function("TOKEN", "roundtableThreadExists", "RT_GET_CONFIRM_RETRIES",
    "RT_GET_CONFIRM_DELAY_MS", "buildRoundtableThreadCreateBody", "fetch", "RT_DISCORD_API",
    "classifyThreadCreate", "process", "setTimeout", "performance", `${compiled}; return ensureRoundtableThread`);
  const ensure = build(token, async (_id: string, _parent: string, timeout?: number) => {
    probes++;
    if (slow) elapsed += timeout ?? 5000;
    return probes === foundAt;
  }, Number(source.match(/const RT_GET_CONFIRM_RETRIES = (\d+)/)![1]),
  Number(source.match(/const RT_GET_CONFIRM_DELAY_MS = (\d+)/)![1]), async () => ({ name: "topic", auto_archive_duration: 60 }),
  async (_url: string, init: RequestInit) => {
    creates++;
    signals.push(init.signal!);
    return { status: 201 };
  }, "https://discord.com/api/v10", () => "created", { stderr: { write() {} } },
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
  test("system messages never reach inbound, including allowed Lead bots", () => {
    const callbackStart = source.indexOf("client.on('messageCreate', msg => {");
    const code = source.slice(callbackStart, source.indexOf("\n})", callbackStart) + 3);
    let handler: (msg: unknown) => void = () => {};
    const inbound: unknown[] = [];
    new Function("client", "gatewayHealth", "loadAccess", "handleInbound", "process", code)(
      { user: { id: "self" }, on: (_event: string, fn: typeof handler) => { handler = fn; } },
      { onSelfEcho() {} }, () => ({ allowBots: ["lead"] }),
      async (msg: unknown) => { inbound.push(msg); }, { stderr: { write() {} } });
    handler({ system: true, author: { id: "lead", bot: true } });
    expect(inbound).toEqual([]);
    handler({ system: false, author: { id: "lead", bot: true } });
    expect(inbound).toHaveLength(1);
  });
});
