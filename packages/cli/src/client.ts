import { ProtocolClient } from "@cadmus/contract/client";

export interface ClientConnection {
	url: string;
	token: string;
	account?: string;
	family?: string;
}

/**
 * `/ws` opens with a single-use ticket minted over the header-backed RPC for
 * every credential. API tokens (`cad_pat_`, `cad_svc_`) are accepted as
 * `Authorization: Bearer` on `/api` and `/rpc` (`CADMUS_TOKEN`).
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
