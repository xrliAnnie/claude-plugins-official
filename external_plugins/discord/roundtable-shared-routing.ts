/**
 * FLY-569 — shared NON-TOKEN roundtable routing source (PURE, side-effect-free).
 *
 * Problem: reply-in-thread used to require per-lead env (FLYWHEEL_ROUNDTABLE_*).
 * Token-isolated companion Claude daemons (Belle/atlas/rafiki) deliberately
 * `unset` all Flywheel env + pin their own DISCORD_STATE_DIR (a security wall:
 * own bot token, no Flywheel-token pollution), so they never set those vars and
 * their reply landed in the parent channel instead of the topic thread.
 *
 * Fix: resolve the roundtable channel id from a dedicated BENIGN file
 * (~/.flywheel/roundtable.json) holding ONLY a Discord channel snowflake. The
 * parser accepts `^[0-9]{15,21}$` and DROPS every other field, so the file can
 * never surface a token/secret even if one is accidentally placed in it — this
 * is the structural leak guard that keeps token isolation intact while making
 * reply-in-thread default-on systemically (no per-lead patch).
 *
 * This module is intentionally free of top-level side effects so it can be unit
 * tested without importing server.ts (which logs in to Discord at import time).
 */
import { readFileSync as fsReadFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";

/** Discord snowflake: 15-21 digits. Same guard the Flywheel setup scripts use. */
const SNOWFLAKE_RE = /^[0-9]{15,21}$/;

/** Pure: parse the shared-config JSON text → at most a benign `{channelId}`.
 * Only a valid Discord snowflake survives; all other fields (incl. anything
 * token-shaped) are dropped. */
export function parseSharedRoundtableRouting(text: string): { channelId?: string } {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return {};
	}
	const id = (raw as { channelId?: unknown } | null)?.channelId;
	const channelId = typeof id === "string" ? id.trim() : "";
	return SNOWFLAKE_RE.test(channelId) ? { channelId } : {};
}

export interface SharedRoutingIO {
	readFileSync: (path: string, encoding: "utf8") => string;
}

/**
 * Load the shared non-token roundtable routing config.
 *
 * Resolution: `FLYWHEEL_ROUNDTABLE_CONFIG_FILE` (explicit override, used by the
 * QA Room / tests) else `~/.flywheel/roundtable.json` (default).
 *
 * Failure handling:
 *  - missing DEFAULT file (ENOENT) → silent `{}` (byte-compat: vanilla installs
 *    + token-isolated daemons with no Flywheel setup behave exactly as before).
 *  - explicitly-configured file unreadable, OR default path with a non-ENOENT
 *    read error (e.g. EACCES) → `{}` + a bounded stderr warning (an operator
 *    pointed at it / something is wrong, don't fail silently).
 *  - present but no valid channelId → `{}` + warning.
 */
export function loadSharedRoundtableRouting(
	env: Record<string, string | undefined> = process.env,
	io: SharedRoutingIO = { readFileSync: fsReadFileSync },
	warn: (msg: string) => void = (m) => {
		process.stderr.write(m);
	},
): { channelId?: string } {
	const configured = (env.FLYWHEEL_ROUNDTABLE_CONFIG_FILE ?? "").trim();
	const explicit = configured.length > 0;
	const path = explicit ? configured : join(homedir(), ".flywheel", "roundtable.json");
	let text: string;
	try {
		text = io.readFileSync(path, "utf8");
	} catch (e) {
		const code = (e as { code?: string } | undefined)?.code;
		// Silent only for the missing DEFAULT file. Explicit override unreadable,
		// or default path with a real read error (not just absent) → warn.
		if (explicit || (code && code !== "ENOENT")) {
			warn(
				`[roundtable] shared config ${path} unreadable (${code ?? String(e)}) — reply-in-thread stays OFF\n`,
			);
		}
		return {};
	}
	const out = parseSharedRoundtableRouting(text);
	if (!out.channelId) {
		warn(
			`[roundtable] shared config ${path} present but has no valid channelId — reply-in-thread stays OFF\n`,
		);
	}
	return out;
}
