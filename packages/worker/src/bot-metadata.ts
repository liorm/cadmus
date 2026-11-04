import { ProtocolValidationError } from "./protocol/validate.js";
import {
	BOT_METADATA_KEY_PATTERN,
	BOT_METADATA_MAX_KEYS,
	BOT_METADATA_MAX_VALUE_LENGTH,
	type BotMetadata,
	type BotMetadataPatch,
} from "./protocol.js";

const KEY_RE = new RegExp(BOT_METADATA_KEY_PATTERN);

/**
 * Applies a metadata patch: string values set/overwrite, `null` deletes.
 * Omitted keys are left unchanged. Empty result is `undefined`.
 */
export function mergeMetadataPatch(
	existing: BotMetadata | undefined,
	patch: BotMetadataPatch,
): BotMetadata | undefined {
	const next: Record<string, string> = { ...(existing ?? {}) };
	for (const [key, value] of Object.entries(patch)) {
		if (value === null) {
			delete next[key];
		} else {
			next[key] = value;
		}
	}
	return Object.keys(next).length > 0 ? next : undefined;
}

export function assertBotMetadata(
	metadata: BotMetadata | BotMetadataPatch | undefined,
): void {
	if (metadata === undefined) return;
	const keys = Object.keys(metadata);
	if (keys.length > BOT_METADATA_MAX_KEYS) {
		throw new ProtocolValidationError(
			`Bot metadata exceeds ${BOT_METADATA_MAX_KEYS} keys`,
			"invalid_command",
		);
	}
	for (const key of keys) {
		if (!KEY_RE.test(key)) {
			throw new ProtocolValidationError(
				`Invalid metadata key '${key}': must match /${BOT_METADATA_KEY_PATTERN}/`,
				"invalid_command",
			);
		}
		const value = metadata[key];
		if (
			value !== null &&
			value !== undefined &&
			value.length > BOT_METADATA_MAX_VALUE_LENGTH
		) {
			throw new ProtocolValidationError(
				`Metadata value for '${key}' exceeds ${BOT_METADATA_MAX_VALUE_LENGTH} characters`,
				"invalid_command",
			);
		}
	}
}
