import { assertUtcIsoTimestamp } from "./shared-discord-utc-timestamp";

export const CHAT_DELIVERY_NORMALIZER_CONTRACT =
	"lead-discord-chat-normalizer/v1";
export const CHAT_DELIVERY_ENVELOPE_PREFIX = "[discord-chat-delivery v1] ";
const LEGACY_CHAT_ENVELOPE_PREFIX = "[discord-chat-receipt v1] ";
const DISCORD_SNOWFLAKE = /^\d+$/;
const DISCORD_ATTACHMENT_SNOWFLAKE = /^\d{17,20}$/;

export type ChatDeliveryMessageKind = "dm" | "guild" | "roundtable";

export interface ChatDeliveryAttachment {
	attachmentId?: string;
	name: string;
	type: string;
	sizeKb: number;
	unavailableReason?: "invalid_metadata" | "producer_identity_missing";
}

export const CHAT_DELIVERY_ORIGINS = [
	"discord",
	"voice",
	"voice_minutes",
] as const;
export type ChatDeliveryOrigin = (typeof CHAT_DELIVERY_ORIGINS)[number];

function parseOrigin(value: unknown): ChatDeliveryOrigin | undefined {
	if (value === undefined) return undefined;
	if (
		typeof value === "string" &&
		(CHAT_DELIVERY_ORIGINS as readonly string[]).includes(value)
	) {
		return value as ChatDeliveryOrigin;
	}
	throw new Error("origin must be discord, voice or voice_minutes");
}

/** Origins that are bound to one voice session and must carry its id. */
export function isVoiceSessionOrigin(
	origin: ChatDeliveryOrigin | undefined,
): boolean {
	return origin === "voice" || origin === "voice_minutes";
}

export interface ChatDeliveryEnvelopeV1 {
	v: 1;
	deliveryId: string;
	leadId: string;
	chatId: string;
	originChannelId: string;
	messageId: string;
	authorId: string;
	authorName: string;
	ts: string;
	priority: 0 | 1;
	msgKind: ChatDeliveryMessageKind;
	attachments: ChatDeliveryAttachment[];
	text: string;
	/**
	 * `voice` is a live founder utterance the Lead answers in the thread.
	 * `voice_minutes` is the after-the-fact record of an already-ended voice
	 * session: it carries no founder authority and asks for no spoken reply.
	 */
	origin?: ChatDeliveryOrigin;
	voiceSessionId?: string;
	heldSince?: string;
	heldReason?: "discord_wiring_broken";
	replyChannelId?: string;
	replyTo?: { messageId: string; channelId: string; authorId?: string };
	replyRoute?: {
		kind: "roundtable_thread_from_message";
		parentChannelId: string;
		sourceMessageId: string;
		threadId: string;
		threadName?: string;
	};
}

function requiredText(value: unknown, field: string): string {
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(`${field} is required`);
	}
	return value.trim();
}

function snowflake(value: unknown, field: string): string {
	const parsed = requiredText(value, field);
	if (!DISCORD_SNOWFLAKE.test(parsed)) {
		throw new Error(`${field} must be a Discord snowflake`);
	}
	return parsed;
}

export function chatDeliveryId(leadId: string, messageId: string): string {
	return `chat:${requiredText(leadId, "leadId")}:${snowflake(messageId, "messageId")}`;
}

export function normalizeChatDeliveryAttachments(
	value: unknown,
): ChatDeliveryAttachment[] {
	if (!Array.isArray(value)) {
		throw new Error("attachments must be an array");
	}
	const normalizedAttachments: ChatDeliveryAttachment[] = value.map(
		(attachment) => {
			const candidate =
				attachment &&
				typeof attachment === "object" &&
				!Array.isArray(attachment)
					? (attachment as Record<string, unknown>)
					: {};
			const nameValid =
				typeof candidate.name === "string" && candidate.name.trim().length > 0;
			const typeValid =
				typeof candidate.type === "string" && candidate.type.trim().length > 0;
			const sizeValid =
				typeof candidate.sizeKb === "number" &&
				Number.isFinite(candidate.sizeKb) &&
				candidate.sizeKb >= 0;
			const attachmentId =
				typeof candidate.attachmentId === "string" &&
				DISCORD_ATTACHMENT_SNOWFLAKE.test(candidate.attachmentId)
					? candidate.attachmentId
					: undefined;
			const idInvalid =
				candidate.attachmentId !== undefined && attachmentId === undefined;
			const declaredReasonValid =
				candidate.unavailableReason === undefined ||
				candidate.unavailableReason === "invalid_metadata" ||
				candidate.unavailableReason === "producer_identity_missing";
			const metadataInvalid =
				!nameValid ||
				!typeValid ||
				!sizeValid ||
				idInvalid ||
				!declaredReasonValid ||
				candidate.unavailableReason === "invalid_metadata" ||
				(attachmentId !== undefined &&
					candidate.unavailableReason !== undefined);
			return {
				name: nameValid ? (candidate.name as string).trim() : "attachment",
				type: typeValid
					? (candidate.type as string).trim()
					: "application/octet-stream",
				sizeKb: sizeValid ? (candidate.sizeKb as number) : 0,
				...(!metadataInvalid && attachmentId ? { attachmentId } : {}),
				...(metadataInvalid
					? { unavailableReason: "invalid_metadata" as const }
					: !attachmentId
						? { unavailableReason: "producer_identity_missing" as const }
						: {}),
			};
		},
	);
	const attachmentIdCounts = new Map<string, number>();
	for (const attachment of normalizedAttachments) {
		if (!attachment.attachmentId) continue;
		attachmentIdCounts.set(
			attachment.attachmentId,
			(attachmentIdCounts.get(attachment.attachmentId) ?? 0) + 1,
		);
	}
	const attachments = normalizedAttachments.map((attachment) => {
		if (
			!attachment.attachmentId ||
			attachmentIdCounts.get(attachment.attachmentId) === 1
		) {
			return attachment;
		}
		const { attachmentId: _duplicateId, ...metadata } = attachment;
		return { ...metadata, unavailableReason: "invalid_metadata" as const };
	});
	return attachments;
}

export function normalizeChatDeliveryReplyTo(
	value: unknown,
): NonNullable<ChatDeliveryEnvelopeV1["replyTo"]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("replyTo must be an object");
	}
	const reference = value as Record<string, unknown>;
	return {
		messageId: snowflake(reference.messageId, "replyTo.messageId"),
		channelId: snowflake(reference.channelId, "replyTo.channelId"),
		...(reference.authorId === undefined
			? {}
			: { authorId: snowflake(reference.authorId, "replyTo.authorId") }),
	};
}

export function normalizeChatDeliveryReplyRoute(
	value: unknown,
): NonNullable<ChatDeliveryEnvelopeV1["replyRoute"]> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("replyRoute must be an object");
	}
	const route = value as Record<string, unknown>;
	if (route.kind !== "roundtable_thread_from_message") {
		throw new Error("replyRoute.kind is invalid");
	}
	return {
		kind: route.kind,
		parentChannelId: snowflake(
			route.parentChannelId,
			"replyRoute.parentChannelId",
		),
		sourceMessageId: snowflake(
			route.sourceMessageId,
			"replyRoute.sourceMessageId",
		),
		threadId: snowflake(route.threadId, "replyRoute.threadId"),
		...(route.threadName === undefined
			? {}
			: {
					threadName: requiredText(route.threadName, "replyRoute.threadName"),
				}),
	};
}

export function normalizeChatDeliveryEnvelope(
	value: Record<string, unknown>,
): ChatDeliveryEnvelopeV1 {
	if (value.v !== 1) throw new Error("chat delivery v1 envelope is required");
	const leadId = requiredText(value.leadId, "leadId");
	const messageId = snowflake(value.messageId, "messageId");
	const deliveryId = requiredText(
		value.deliveryId ?? value.receiptId,
		"deliveryId",
	);
	if (deliveryId !== chatDeliveryId(leadId, messageId)) {
		throw new Error(
			"chat delivery v1 envelope deliveryId does not match route",
		);
	}
	const ts = requiredText(value.ts, "ts");
	assertUtcIsoTimestamp(ts, "ts");
	if (typeof value.text !== "string") throw new Error("text must be a string");
	if (value.priority !== 0 && value.priority !== 1) {
		throw new Error("priority must be 0 or 1");
	}
	if (
		value.msgKind !== "dm" &&
		value.msgKind !== "guild" &&
		value.msgKind !== "roundtable"
	) {
		throw new Error("msgKind must be dm, guild, or roundtable");
	}
	const attachments = normalizeChatDeliveryAttachments(value.attachments);
	const replyChannelId =
		value.replyChannelId === undefined
			? undefined
			: snowflake(value.replyChannelId, "replyChannelId");
	if ((value.heldSince === undefined) !== (value.heldReason === undefined)) {
		throw new Error("heldSince and heldReason must be provided together");
	}
	const origin = parseOrigin(value.origin);
	if (isVoiceSessionOrigin(origin) !== (value.voiceSessionId !== undefined)) {
		throw new Error("origin and voiceSessionId must be provided together");
	}
	const voiceSessionId =
		value.voiceSessionId === undefined
			? undefined
			: requiredText(value.voiceSessionId, "voiceSessionId");
	let heldSince: string | undefined;
	let heldReason: ChatDeliveryEnvelopeV1["heldReason"];
	if (value.heldSince !== undefined) {
		heldSince = requiredText(value.heldSince, "heldSince");
		assertUtcIsoTimestamp(heldSince, "heldSince");
		if (value.heldReason !== "discord_wiring_broken") {
			throw new Error("heldReason must be discord_wiring_broken");
		}
		heldReason = value.heldReason;
	}
	const replyTo =
		value.replyTo === undefined
			? undefined
			: normalizeChatDeliveryReplyTo(value.replyTo);
	const replyRoute =
		value.replyRoute === undefined
			? undefined
			: normalizeChatDeliveryReplyRoute(value.replyRoute);
	return {
		v: 1,
		deliveryId,
		leadId,
		chatId: snowflake(value.chatId, "chatId"),
		originChannelId: snowflake(value.originChannelId, "originChannelId"),
		messageId,
		authorId: snowflake(value.authorId, "authorId"),
		authorName: requiredText(value.authorName, "authorName"),
		ts,
		priority: value.priority,
		msgKind: value.msgKind,
		attachments,
		text: value.text,
		...(origin ? { origin } : {}),
		...(voiceSessionId ? { voiceSessionId } : {}),
		...(heldSince ? { heldSince, heldReason } : {}),
		...(replyChannelId ? { replyChannelId } : {}),
		...(replyRoute ? { replyRoute } : {}),
		...(replyTo ? { replyTo } : {}),
	};
}

export function encodeChatDeliveryEnvelope(
	envelope: ChatDeliveryEnvelopeV1,
): string {
	return `${CHAT_DELIVERY_ENVELOPE_PREFIX}${JSON.stringify(envelope)}`;
}

export function parseChatDeliveryEnvelope(
	content: string,
): ChatDeliveryEnvelopeV1 {
	const firstLine = content.split("\n", 1)[0] ?? "";
	const prefix = firstLine.startsWith(CHAT_DELIVERY_ENVELOPE_PREFIX)
		? CHAT_DELIVERY_ENVELOPE_PREFIX
		: firstLine.startsWith(LEGACY_CHAT_ENVELOPE_PREFIX)
			? LEGACY_CHAT_ENVELOPE_PREFIX
			: undefined;
	if (!prefix) throw new Error("chat delivery v1 envelope header is missing");
	let decoded: unknown;
	try {
		decoded = JSON.parse(firstLine.slice(prefix.length));
	} catch (error) {
		throw new Error(
			`chat delivery v1 envelope JSON is invalid: ${(error as Error).message}`,
		);
	}
	if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
		throw new Error("chat delivery v1 envelope must be an object");
	}
	return normalizeChatDeliveryEnvelope(decoded as Record<string, unknown>);
}
