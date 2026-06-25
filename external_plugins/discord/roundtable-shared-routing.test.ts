/**
 * FLY-569 — tests for the shared NON-TOKEN roundtable routing loader.
 *
 * Security boundary (NON-NEGOTIABLE): the shared config file may carry ONLY a
 * benign Discord channel snowflake. The parser accepts `^[0-9]{15,21}$` and
 * DROPS every other field — so even if a token/secret is accidentally placed in
 * the file, it can never be surfaced to the plugin. This is the structural leak
 * guard that lets token-isolated companion daemons (Belle/atlas/rafiki) read the
 * file without re-injecting any Flywheel token.
 */
import { test, expect, describe } from "bun:test";
import {
	parseSharedRoundtableRouting,
	loadSharedRoundtableRouting,
} from "./roundtable-shared-routing";

const RT = "1512578695468941333"; // a real Discord snowflake (17 digits)

describe("parseSharedRoundtableRouting (pure, snowflake-only)", () => {
	test("valid snowflake channelId → extracted", () => {
		expect(parseSharedRoundtableRouting(JSON.stringify({ channelId: RT }))).toEqual({
			channelId: RT,
		});
	});

	test("extra/token-ish fields are DROPPED — only channelId survives", () => {
		const out = parseSharedRoundtableRouting(
			JSON.stringify({
				channelId: RT,
				botToken: "super-secret-token",
				guildId: "1485787271192907816",
				DISCORD_BOT_TOKEN: "leak",
			}),
		);
		expect(out).toEqual({ channelId: RT });
		expect(Object.keys(out)).toEqual(["channelId"]);
	});

	test("trims whitespace around a valid snowflake", () => {
		expect(parseSharedRoundtableRouting(JSON.stringify({ channelId: ` ${RT} ` }))).toEqual({
			channelId: RT,
		});
	});

	test("non-snowflake channelId → {} (not a numeric id)", () => {
		expect(parseSharedRoundtableRouting(JSON.stringify({ channelId: "abc" }))).toEqual({});
	});

	test("too-short id → {} (must be 15-21 digits)", () => {
		expect(parseSharedRoundtableRouting(JSON.stringify({ channelId: "123" }))).toEqual({});
	});

	test("empty channelId → {}", () => {
		expect(parseSharedRoundtableRouting(JSON.stringify({ channelId: "" }))).toEqual({});
	});

	test("non-string channelId → {}", () => {
		expect(parseSharedRoundtableRouting(JSON.stringify({ channelId: 1512578695468941333 }))).toEqual(
			{},
		);
	});

	test("invalid JSON → {}", () => {
		expect(parseSharedRoundtableRouting("not json {")).toEqual({});
	});

	test("missing channelId key → {}", () => {
		expect(parseSharedRoundtableRouting(JSON.stringify({ foo: "bar" }))).toEqual({});
	});
});

// fake injectable IO: records the path read, throws a chosen error, or returns text.
function fakeIO(opts: { text?: string; error?: { code?: string } }) {
	const calls: string[] = [];
	return {
		calls,
		io: {
			readFileSync: (path: string) => {
				calls.push(path);
				if (opts.error) {
					const e = new Error("read fail") as Error & { code?: string };
					e.code = opts.error.code;
					throw e;
				}
				return opts.text ?? "";
			},
		},
	};
}

describe("loadSharedRoundtableRouting (IO + env precedence + warnings)", () => {
	test("default path missing (ENOENT) → {} and SILENT (byte-compat)", () => {
		const warns: string[] = [];
		const { io } = fakeIO({ error: { code: "ENOENT" } });
		const out = loadSharedRoundtableRouting({}, io, (m) => warns.push(m));
		expect(out).toEqual({});
		expect(warns).toEqual([]); // missing default file must NOT warn
	});

	test("explicit FLYWHEEL_ROUNDTABLE_CONFIG_FILE unreadable (ENOENT) → {} and WARN", () => {
		const warns: string[] = [];
		const { io, calls } = fakeIO({ error: { code: "ENOENT" } });
		const out = loadSharedRoundtableRouting(
			{ FLYWHEEL_ROUNDTABLE_CONFIG_FILE: "/tmp/explicit-rt.json" },
			io,
			(m) => warns.push(m),
		);
		expect(out).toEqual({});
		expect(calls).toEqual(["/tmp/explicit-rt.json"]); // env path wins
		expect(warns.length).toBe(1); // operator pointed at it → must warn
	});

	test("default path with non-ENOENT read error (EACCES) → {} and WARN", () => {
		const warns: string[] = [];
		const { io } = fakeIO({ error: { code: "EACCES" } });
		const out = loadSharedRoundtableRouting({}, io, (m) => warns.push(m));
		expect(out).toEqual({});
		expect(warns.length).toBe(1);
	});

	test("present + valid → {channelId}, no warn", () => {
		const warns: string[] = [];
		const { io } = fakeIO({ text: JSON.stringify({ channelId: RT }) });
		const out = loadSharedRoundtableRouting({}, io, (m) => warns.push(m));
		expect(out).toEqual({ channelId: RT });
		expect(warns).toEqual([]);
	});

	test("present but invalid channelId → {} and WARN", () => {
		const warns: string[] = [];
		const { io } = fakeIO({ text: JSON.stringify({ channelId: "abc" }) });
		const out = loadSharedRoundtableRouting({}, io, (m) => warns.push(m));
		expect(out).toEqual({});
		expect(warns.length).toBe(1);
	});
});
