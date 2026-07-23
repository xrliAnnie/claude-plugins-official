const DISCORD_API = "https://discord.com/api/v10";
const DEFAULT_AUTO_ARCHIVE_MINUTES = 4320;
const DEFAULT_TIMEOUT_MS = 5_000;
const VALID_AUTO_ARCHIVE_MINUTES = new Set([60, 1440, 4320, 10080]);

export interface RoundtableArchivePolicyDeps {
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	warn?: (message: string) => void;
}

export interface RoundtableThreadCreateBody {
	name: string;
	auto_archive_duration: number;
}

/**
 * Build the exact body used by Discord's create-thread POST.
 *
 * Discord does not apply `default_auto_archive_duration` to API-created
 * threads, so the plugin must read the parent channel and copy a legal value
 * explicitly. The read is bounded and fail-open: every failure warns and
 * returns Discord's API default so inbound message handling can still create
 * the thread.
 */
export async function buildRoundtableThreadCreateBody(
	parentChannelId: string,
	name: string,
	botToken: string,
	deps: RoundtableArchivePolicyDeps = {},
): Promise<RoundtableThreadCreateBody> {
	const fetchImpl = deps.fetchImpl ?? fetch;
	const timeoutMs =
		typeof deps.timeoutMs === "number" &&
		Number.isFinite(deps.timeoutMs) &&
		deps.timeoutMs > 0
			? deps.timeoutMs
			: DEFAULT_TIMEOUT_MS;
	const warn =
		deps.warn ??
		((message: string) => {
			process.stderr.write(`${message}\n`);
		});
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	let archiveMinutes = DEFAULT_AUTO_ARCHIVE_MINUTES;
	let failure: string | undefined;
	try {
		const response = await fetchImpl(
			`${DISCORD_API}/channels/${parentChannelId}`,
			{
				headers: { Authorization: `Bot ${botToken}` },
				signal: controller.signal,
			},
		);
		if (!response.ok) {
			failure = `HTTP ${response.status}`;
		} else {
			const body = (await response.json()) as {
				default_auto_archive_duration?: unknown;
			};
			const value = body.default_auto_archive_duration;
			if (
				typeof value === "number" &&
				VALID_AUTO_ARCHIVE_MINUTES.has(value)
			) {
				archiveMinutes = value;
			} else {
				failure = "missing or invalid default_auto_archive_duration";
			}
		}
	} catch (error) {
		failure = error instanceof Error ? error.message : String(error);
	} finally {
		clearTimeout(timer);
	}

	if (failure) {
		warn(
			`[roundtable] parent channel ${parentChannelId} archive default unavailable (${failure}); using ${DEFAULT_AUTO_ARCHIVE_MINUTES}`,
		);
	}

	return {
		name,
		auto_archive_duration: archiveMinutes,
	};
}
