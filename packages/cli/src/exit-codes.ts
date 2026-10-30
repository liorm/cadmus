import { isAuthError } from "@cadmus/contract/client";

/** Process statuses from the CLI spec. */
export const EXIT_OK = 0;
export const EXIT_PROTOCOL = 1;
export const EXIT_USAGE = 2;
export const EXIT_TRANSPORT = 3;
export const EXIT_TURN = 4;

/**
 * Map an HTTP status and a protocol error code onto a process status.
 * Auth failures are transport (3). Other command failures are protocol (1).
 */
export function exitForCommandFailure(
	status: number | undefined,
	code: string | undefined,
): number {
	if (status === 401 || isAuthError(code)) {
		return EXIT_TRANSPORT;
	}
	return EXIT_PROTOCOL;
}
