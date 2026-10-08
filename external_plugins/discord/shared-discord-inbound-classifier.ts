/** One dependency-free policy for the primary plugin and independent Bridge
 * source. It does not pair users, consume a topic budget, ingest, or approve.
 * The adapter supplies freshly resolved mention/reference and topic evidence. */
export const DISCORD_INBOUND_CLASSIFIER_CONTRACT =
	"discord-inbound-classifier/v1";
const SNOWFLAKE = /^\d{17,20}$/;
const LEAD_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const PERMISSION_REPLY_RE = /^\s*(y|yes|n|no)\s+([a-km-z]{5})\s*$/i;

export interface DiscordPermissionReply {
	requestId: string;
	behavior: "allow" | "deny";
}
export type DiscordInboundClassification =
	| {
			action: "drop";
			reason:
				| "self_echo"
				| "bot_not_allowed"
				| "disabled"
				| "sender_not_allowed"
				| "group_disabled"
				| "mention_required"
				| "different_owner"
				| "topic_policy_denied";
	  }
	| {
			action: "quarantine";
			reason:
				| "message_invalid"
				| "policy_unavailable"
				| "owner_unproven"
				| "topic_policy_unproven";
	  }
	| { action: "pair" }
	| { action: "deliver"; classification: "chat" }
	| ({
			action: "deliver";
			classification: "permission";
	  } & DiscordPermissionReply);

function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === "object" && !Array.isArray(value);
}
function ids(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= 1024 &&
		value.every((id) => typeof id === "string" && SNOWFLAKE.test(id))
	);
}
export function classifyDiscordPermissionReply(
	content: unknown,
): DiscordPermissionReply | null {
	if (typeof content !== "string" || content.length > 65_536) return null;
	const match = PERMISSION_REPLY_RE.exec(content);
	return match
		? {
				requestId: match[2]!.toLowerCase(),
				behavior: match[1]!.toLowerCase().startsWith("y") ? "allow" : "deny",
			}
		: null;
}
export function classifyDiscordInbound(
	input: unknown,
): DiscordInboundClassification {
	const invalid: DiscordInboundClassification = {
		action: "quarantine",
		reason: "message_invalid",
	};
	if (
		!record(input) ||
		(input.channelKind !== "dm" && input.channelKind !== "guild") ||
		typeof input.senderId !== "string" ||
		!SNOWFLAKE.test(input.senderId) ||
		typeof input.policyChannelId !== "string" ||
		!SNOWFLAKE.test(input.policyChannelId) ||
		typeof input.content !== "string" ||
		input.content.length > 65_536 ||
		typeof input.isSelf !== "boolean" ||
		typeof input.authorIsBot !== "boolean" ||
		typeof input.mentionMatched !== "boolean" ||
		typeof input.topicThread !== "boolean" ||
		typeof input.requireOwner !== "boolean"
	)
		return invalid;
	if (input.isSelf) return { action: "drop", reason: "self_echo" };
	const access = input.access;
	const unavailable: DiscordInboundClassification = {
		action: "quarantine",
		reason: "policy_unavailable",
	};
	if (
		!record(access) ||
		!["disabled", "allowlist", "pairing"].includes(String(access.dmPolicy)) ||
		!ids(access.allowFrom) ||
		!record(access.groups) ||
		(access.allowBots !== undefined && !ids(access.allowBots))
	)
		return unavailable;
	if (
		input.authorIsBot &&
		!(access.allowBots as string[] | undefined)?.includes(input.senderId)
	)
		return { action: "drop", reason: "bot_not_allowed" };
	if (access.dmPolicy === "disabled")
		return { action: "drop", reason: "disabled" };
	if (input.requireOwner) {
		if (
			typeof input.leadId !== "string" ||
			!LEAD_ID.test(input.leadId) ||
			typeof input.ownerLeadId !== "string" ||
			!LEAD_ID.test(input.ownerLeadId)
		)
			return { action: "quarantine", reason: "owner_unproven" };
		if (input.ownerLeadId !== input.leadId)
			return { action: "drop", reason: "different_owner" };
	}
	if (input.channelKind === "dm") {
		if (!access.allowFrom.includes(input.senderId))
			return access.dmPolicy === "allowlist"
				? { action: "drop", reason: "sender_not_allowed" }
				: { action: "pair" };
	} else {
		if (!Object.hasOwn(access.groups, input.policyChannelId))
			return { action: "drop", reason: "group_disabled" };
		const group = access.groups[input.policyChannelId];
		if (
			!record(group) ||
			(group.allowFrom !== undefined && !ids(group.allowFrom)) ||
			(group.requireMention !== undefined &&
				typeof group.requireMention !== "boolean")
		)
			return unavailable;
		const allow = group.allowFrom as string[] | undefined;
		if (allow?.length && !allow.includes(input.senderId))
			return { action: "drop", reason: "sender_not_allowed" };
		if (input.topicThread) {
			if (input.topicDecision !== "deliver" && input.topicDecision !== "drop")
				return { action: "quarantine", reason: "topic_policy_unproven" };
			if (input.topicDecision === "drop")
				return { action: "drop", reason: "topic_policy_denied" };
		} else if ((group.requireMention ?? true) && !input.mentionMatched)
			return { action: "drop", reason: "mention_required" };
	}
	const permission = classifyDiscordPermissionReply(input.content);
	return permission
		? { action: "deliver", classification: "permission", ...permission }
		: { action: "deliver", classification: "chat" };
}
