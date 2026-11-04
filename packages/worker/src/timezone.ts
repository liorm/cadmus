import { ProtocolValidationError } from "./protocol/validate.js";

/** Returns true if `tz` is a valid IANA timezone identifier. */
export function isValidIanaTimezone(tz: string): boolean {
	if (typeof tz !== "string" || tz.trim().length === 0) return false;
	try {
		Intl.DateTimeFormat("en-US", { timeZone: tz });
		return true;
	} catch {
		return false;
	}
}

/** Rejects non-IANA timezone strings with a protocol error. */
export function assertValidIanaTimezone(tz: string): void {
	if (!isValidIanaTimezone(tz)) {
		throw new ProtocolValidationError(
			`Invalid IANA timezone '${tz}'`,
			"invalid_command",
		);
	}
}
