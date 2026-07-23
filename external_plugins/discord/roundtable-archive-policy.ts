const DISCORD_API = "https://discord.com/api/v10";
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
 * explicitly. The read is bounded and fail-closed: every failure warns and
 * returns null so the caller can leave the message in the parent channel while
 * the Bridge poller retries. Creating a 4320-minute thread here would make a
 * transient cold-read failure permanent.
 */
export async function buildRoundtableThreadCreateBody(
	parentChannelId: string,
	name: string,
	botToken: string,
	deps: RoundtableArchivePolicyDeps = {},
): Promise<RoundtableThreadCreateBody | null> {
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

	let archiveMinutes: number | undefined;
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
			`[roundtable] parent channel ${parentChannelId} archive default unavailable (${failure}); refusing to create a fallback thread`,
		);
		return null;
	}

	return {
		name,
		auto_archive_duration: archiveMinutes!,
	};
}
