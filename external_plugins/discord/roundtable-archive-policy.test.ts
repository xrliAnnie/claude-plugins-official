import { describe, expect, test } from "bun:test";
import { buildRoundtableThreadCreateBody } from "./roundtable-archive-policy";

const CHANNEL_ID = "1512578695468941333";
const TOKEN = "test-token";
const FALLBACK = 4320;

function response(status: number, body: unknown): Response {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: async () => body,
	} as Response;
}

async function createBody(
	fetchImpl: typeof fetch,
	opts: { timeoutMs?: number; warns?: string[] } = {},
) {
	const warns = opts.warns ?? [];
	const body = await buildRoundtableThreadCreateBody(
		CHANNEL_ID,
		"descriptive topic",
		TOKEN,
		{
			fetchImpl,
			timeoutMs: opts.timeoutMs,
			warn: (message) => warns.push(message),
		},
	);
	return { body, warns };
}

describe("buildRoundtableThreadCreateBody (FLY-1435)", () => {
	for (const value of [60, 1440, 4320, 10080]) {
		test(`legal parent default ${value} is copied into the final POST body`, async () => {
			const { body, warns } = await createBody(
				(async () =>
					response(200, {
						default_auto_archive_duration: value,
					})) as typeof fetch,
			);

			expect(body).toEqual({
				name: "descriptive topic",
				auto_archive_duration: value,
			});
			expect(warns).toEqual([]);
		});
	}

	for (const [label, value] of [
		["missing", undefined],
		["null", null],
		["string", "60"],
		["unsupported", 30],
		["out of range", 10081],
		["NaN", Number.NaN],
	] as const) {
		test(`${label} parent default falls back in the final POST body`, async () => {
			const payload =
				label === "missing"
					? {}
					: { default_auto_archive_duration: value };
			const { body, warns } = await createBody(
				(async () => response(200, payload)) as typeof fetch,
			);

			expect(body.auto_archive_duration).toBe(FALLBACK);
			expect(warns).toHaveLength(1);
		});
	}

	for (const status of [401, 403, 404, 429, 500, 503]) {
		test(`HTTP ${status} falls back and still yields a final POST body`, async () => {
			const { body, warns } = await createBody(
				(async () => response(status, {})) as typeof fetch,
			);

			expect(body.auto_archive_duration).toBe(FALLBACK);
			expect(warns).toHaveLength(1);
		});
	}

	test("malformed JSON falls back and still yields a final POST body", async () => {
		const { body, warns } = await createBody(
			(async () =>
				({
					ok: true,
					status: 200,
					json: async () => {
						throw new SyntaxError("bad json");
					},
				}) as Response) as typeof fetch,
		);

		expect(body.auto_archive_duration).toBe(FALLBACK);
		expect(warns).toHaveLength(1);
	});

	test("network rejection falls back and still yields a final POST body", async () => {
		const { body, warns } = await createBody(
			(async () => {
				throw new Error("socket closed");
			}) as typeof fetch,
		);

		expect(body.auto_archive_duration).toBe(FALLBACK);
		expect(warns).toHaveLength(1);
	});

	test("timeout is bounded, falls back, and still yields a final POST body", async () => {
		const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener(
					"abort",
					() => reject(new DOMException("aborted", "AbortError")),
					{ once: true },
				);
			})) as typeof fetch;

		const { body, warns } = await createBody(hangingFetch, { timeoutMs: 5 });

		expect(body.auto_archive_duration).toBe(FALLBACK);
		expect(warns).toHaveLength(1);
	});
});
