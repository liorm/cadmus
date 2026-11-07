const FALLBACK_TIME_ZONES = [
	"UTC",
	"Asia/Jerusalem",
	"America/New_York",
	"Europe/London",
] as const;

function supportedTimeZones(): string[] {
	if (typeof Intl === "undefined" || !("supportedValuesOf" in Intl)) {
		return [...FALLBACK_TIME_ZONES];
	}
	try {
		const zones = Intl.supportedValuesOf("timeZone");
		return zones.length > 0 ? [...zones] : [...FALLBACK_TIME_ZONES];
	} catch {
		return [...FALLBACK_TIME_ZONES];
	}
}

/** IANA zones for the picker, always including UTC and the saved value. */
export function timeZoneOptions(current: string): string[] {
	const base = supportedTimeZones();
	const zones = base.includes("UTC") ? base : ["UTC", ...base];
	if (current && !zones.includes(current)) return [current, ...zones];
	return zones;
}

/** Case-insensitive substring filter. An empty query returns every zone. */
export function filterTimeZones(
	zones: readonly string[],
	query: string,
): string[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [...zones];
	return zones.filter((zone) => zone.toLowerCase().includes(needle));
}

/** A zone may be stored only when it is one of the listed options. */
export function selectableTimeZone(
	zones: readonly string[],
	candidate: string,
): string | null {
	return zones.includes(candidate) ? candidate : null;
}
