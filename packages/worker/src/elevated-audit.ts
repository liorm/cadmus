import type { Grant } from "@cadmus/contract/grants";
import { type CallerMeta, isElevatedUse } from "./authz.js";
import type { LogFields } from "./log.js";
import type { AdminStore } from "./store/admin-interface.js";
import type { ElevatedOperation } from "./store/d1-sessions.js";

/**
 * Runs one command inside the elevated-audit lifecycle shared by
 * `family.create` (edge) and `CadmusBotFamilyDO.dispatchCommand`.
 *
 * The attempt row is written before `run`. That write is what allowed the
 * command to start, so a failed attempt write refuses the command instead of
 * leaving a committed change with no audit. The outcome row is retried three
 * times. A lost outcome never turns a committed action into a failure; the
 * attempt row with the same operation id stays as the pending record.
 */
export async function withElevatedAudit<T>(input: {
	adminStore: Pick<AdminStore, "auditElevatedCommand">;
	caller: CallerMeta;
	grant: Grant;
	/**
	 * Overrides `isElevatedUse(grant, caller)`. Leave unset to record the use
	 * when the caller is in admin mode. Pass `false` when this call is not an
	 * elevated use.
	 */
	elevated?: boolean;
	commandType: string;
	familyId?: string;
	warn: (message: string, fields?: LogFields) => void;
	run: () => Promise<T>;
}): Promise<T> {
	const operation: ElevatedOperation = {
		id: crypto.randomUUID(),
		familyId: input.familyId,
	};
	const elevated = input.elevated ?? isElevatedUse(input.grant, input.caller);
	const elevatedSession =
		input.caller.sessionId && elevated ? input.caller.sessionId : undefined;
	if (elevatedSession) {
		await input.adminStore.auditElevatedCommand(
			elevatedSession,
			input.commandType,
			"attempt",
			operation,
		);
	}
	let succeeded = false;
	try {
		const result = await input.run();
		succeeded = true;
		return result;
	} finally {
		if (elevatedSession) {
			await recordElevatedOutcome(
				input.adminStore,
				elevatedSession,
				input.commandType,
				operation,
				succeeded,
				input.warn,
			);
		}
	}
}

async function recordElevatedOutcome(
	adminStore: Pick<AdminStore, "auditElevatedCommand">,
	sessionId: string,
	commandType: string,
	operation: ElevatedOperation,
	ok: boolean,
	warn: (message: string, fields?: LogFields) => void,
): Promise<void> {
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			await adminStore.auditElevatedCommand(
				sessionId,
				commandType,
				ok ? "ok" : "failed",
				operation,
			);
			return;
		} catch {
			if (attempt === 3) {
				warn("elevated command outcome not recorded", {
					command: commandType,
					operation: operation.id,
				});
			}
		}
	}
}
