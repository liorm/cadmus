/**
 * Path helpers for `/api/*` that do not import TypeBox.
 *
 * Query encoding is `encodePayloadQuery` in `@cadmus/contract/routes`.
 * The Worker re-exports that function. Method selection stays on the command
 * schema `readOnly` flag (`apiRouteForCommand` in `rest.ts`).
 */

export const API_PATH_PREFIX = "/api/";

/** `file.read` -> `/api/file/read`. */
export function apiPathFromCommandType(commandType: string): string {
	return `${API_PATH_PREFIX}${commandType.replaceAll(".", "/")}`;
}

/**
 * `/api/file/read` -> `file.read`.
 * Returns undefined for paths outside `/api/*`, empty paths, or trailing slashes.
 * Does not check that the command exists.
 */
export function commandTypeFromApiPath(pathname: string): string | undefined {
	if (!pathname.startsWith(API_PATH_PREFIX)) return undefined;
	const rest = pathname.slice(API_PATH_PREFIX.length);
	if (rest.length === 0 || rest.endsWith("/")) return undefined;
	const segments = rest.split("/");
	if (segments.some((segment) => segment.length === 0)) return undefined;
	return segments.join(".");
}
