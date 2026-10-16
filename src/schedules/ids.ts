export function harvestId(chatKey: string): string {
	return `harvest:${chatKey}`;
}

export function isHarvestId(id: string): boolean {
	return id.startsWith("harvest:");
}

/** Child submit key: one harvest per idle entry, retries of the same child are duplicates. */
export function harvestRequestId(chatKey: string, entryId: number): string {
	return `sched:${harvestId(chatKey)}:${entryId}`;
}
