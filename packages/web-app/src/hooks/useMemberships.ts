import { useSession } from "@/context/SessionContext";
import type { SessionMembership } from "@/lib/session";

export type Membership = SessionMembership;

/**
 * The accounts the signed-in user can act in. Empty without a user session
 * (no-session fallback, token sessions): there is nothing to switch to.
 */
export function useMemberships(): Membership[] {
	return useSession().memberships;
}
