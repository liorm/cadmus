/**
 * Sessionless credential name for a `cad_pat_` / `cad_svc_` bearer.
 * The suffix is the domain-separated token hash, never the raw secret.
 * Sockets re-read that row on each message, the same way a legacy member
 * token does, so revocation is not stuck on the edge cache.
 */
export const API_TOKEN_CREDENTIAL_PREFIX = "api-token:";

/** Edge cache lifetime for a resolved API-token bearer. */
export const API_TOKEN_CACHE_TTL_SECONDS = 60;

export function apiTokenCredential(hash: string): string {
	return `${API_TOKEN_CREDENTIAL_PREFIX}${hash}`;
}

/** The 64-char hex hash stored on the credential, or undefined when it is not one. */
export function apiTokenHashFromCredential(
	credential: string | null | undefined,
): string | undefined {
	if (!credential?.startsWith(API_TOKEN_CREDENTIAL_PREFIX)) return undefined;
	const hash = credential.slice(API_TOKEN_CREDENTIAL_PREFIX.length);
	return /^[0-9a-f]{64}$/.test(hash) ? hash : undefined;
}
