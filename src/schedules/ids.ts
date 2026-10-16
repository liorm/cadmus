export function harvestId(chatKey: string): string {
	return `harvest:${chatKey}`;
}

export function isHarvestId(id: string): boolean {
	return id.startsWith("harvest:");
}
