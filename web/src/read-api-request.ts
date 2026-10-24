import { API_ROUTES } from "@cadmus/contract/routes";

/** Inverse of the generated route table. Used by web tests to read mocked fetches. */
export function commandTypeFromApiPath(pathname: string): string | undefined {
	for (const [type, route] of Object.entries(API_ROUTES)) {
		if (route.path === pathname) return type;
	}
	return undefined;
}

/**
 * Heuristic inverse of `encodePayloadQuery` for test mocks.
 * Repeated keys become arrays. `true`/`false` and integers are coerced.
 * JSON objects and arrays are parsed.
 */
export function decodePayloadQuery(
	params: URLSearchParams,
): Record<string, unknown> {
	const grouped = new Map<string, string[]>();
	for (const [key, value] of params) {
		const list = grouped.get(key);
		if (list) list.push(value);
		else grouped.set(key, [value]);
	}
	const result: Record<string, unknown> = {};
	for (const [key, values] of grouped) {
		const decoded = values.map(decodeScalar);
		result[key] = decoded.length > 1 ? decoded : decoded[0];
	}
	return result;
}

function decodeScalar(raw: string): unknown {
	if (raw === "true") return true;
	if (raw === "false") return false;
	if (/^-?\d+$/.test(raw)) return Number(raw);
	const trimmed = raw.trimStart();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			return JSON.parse(raw);
		} catch {
			return raw;
		}
	}
	return raw;
}
