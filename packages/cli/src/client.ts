import { ProtocolClient } from "@cadmus/contract/client";

export interface ClientConnection {
	url: string;
	token: string;
	account?: string;
	family?: string;
}

/**
 * `/ws` opens with a single-use ticket minted over the header-backed RPC.
 * `Authorization: Bearer` on `/api` and `/rpc` is a session access token
 * (`cad_at_`). `CADMUS_TOKEN` is that same override when the caller already
 * holds one.
 */
export function createClient(
	connection: ClientConnection,
	options: Partial<ConstructorParameters<typeof ProtocolClient>[0]> = {},
): ProtocolClient {
	return new ProtocolClient({
		baseUrl: connection.url,
		token: connection.token,
		accountId: connection.account,
		familyId: connection.family,
		...options,
	});
}
