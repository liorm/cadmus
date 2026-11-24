import type { ModelInfo, ModelTier } from "@cadmus/contract/types";
import { modelListRef } from "./model-ref";

const PROVIDER_LABELS: Readonly<Record<string, string>> = {
	google: "Google Gemini",
	anthropic: "Anthropic",
	openai: "OpenAI",
	xai: "xAI",
	faux: "Faux (Offline)",
};

const PROVIDER_ORDER: Readonly<Record<string, number>> = {
	google: 0,
	anthropic: 1,
	openai: 2,
	xai: 3,
	faux: 4,
};

const TIER_ORDER: Readonly<Record<ModelTier, number>> = {
	frontier: 0,
	fast: 1,
	other: 2,
};

export function effectiveModelTier(model: Pick<ModelInfo, "tier">): ModelTier {
	return model.tier ?? "other";
}

export function isPopularModelTier(tier: ModelTier): boolean {
	return tier === "frontier" || tier === "fast";
}

export function providerDisplayName(providerId: string): string {
	return PROVIDER_LABELS[providerId] ?? providerId;
}

export interface ModelSelectItem {
	ref: string;
	model: ModelInfo;
	tier: ModelTier;
}

export interface ModelSelectGroup {
	provider: string;
	label: string;
	authenticated: boolean;
	items: ModelSelectItem[];
}

export interface GroupedModelsResult {
	groups: ModelSelectGroup[];
	totalCount: number;
	visibleCount: number;
	hiddenCount: number;
}

export function groupModelsForSelect(
	models: readonly ModelInfo[],
	options: {
		query?: string;
		showAll?: boolean;
		selectedRef?: string;
	} = {},
): GroupedModelsResult {
	const query = options.query?.trim().toLowerCase() ?? "";
	const showAll = options.showAll ?? false;
	const selectedRef = options.selectedRef;

	const deduped: ModelSelectItem[] = [];
	const seen = new Set<string>();
	for (const model of models) {
		const ref = modelListRef(model);
		if (seen.has(ref)) continue;
		seen.add(ref);
		deduped.push({ ref, model, tier: effectiveModelTier(model) });
	}

	if (selectedRef && !seen.has(selectedRef)) {
		const slash = selectedRef.indexOf("/");
		const provider = slash > 0 ? selectedRef.slice(0, slash) : "custom";
		const id = slash > 0 ? selectedRef.slice(slash + 1) : selectedRef;
		deduped.unshift({
			ref: selectedRef,
			tier: "other",
			model: {
				id,
				provider,
				name: selectedRef,
				authenticated: true,
				credentialConfigured: true,
			},
		});
	}

	const anyNonFauxAuthenticated = deduped.some(
		(item) => item.model.provider !== "faux" && item.model.authenticated,
	);

	const filtered = deduped.filter((item) => {
		if (query.length > 0) {
			const providerLabel = providerDisplayName(item.model.provider);
			return (
				item.ref.toLowerCase().includes(query) ||
				item.model.name.toLowerCase().includes(query) ||
				item.model.id.toLowerCase().includes(query) ||
				item.model.provider.toLowerCase().includes(query) ||
				providerLabel.toLowerCase().includes(query)
			);
		}
		if (showAll) return true;
		if (isPopularModelTier(item.tier)) return true;
		if (selectedRef && item.ref === selectedRef) return true;
		if (!anyNonFauxAuthenticated && item.model.provider === "faux") return true;
		return false;
	});

	const byProvider = new Map<string, ModelSelectItem[]>();
	for (const item of filtered) {
		const list = byProvider.get(item.model.provider);
		if (list) list.push(item);
		else byProvider.set(item.model.provider, [item]);
	}

	const groups: ModelSelectGroup[] = Array.from(byProvider.entries()).map(
		([provider, items]) => {
			items.sort((a, b) => TIER_ORDER[a.tier] - TIER_ORDER[b.tier]);
			return {
				provider,
				label: providerDisplayName(provider),
				authenticated: items.some((i) => i.model.authenticated),
				items,
			};
		},
	);

	groups.sort((a, b) => {
		if (a.authenticated !== b.authenticated) return a.authenticated ? -1 : 1;
		const orderA = PROVIDER_ORDER[a.provider] ?? 99;
		const orderB = PROVIDER_ORDER[b.provider] ?? 99;
		if (orderA !== orderB) return orderA - orderB;
		return a.label.localeCompare(b.label);
	});

	const visibleCount = filtered.length;
	const totalCount = deduped.length;
	const hiddenCount =
		query.length > 0 ? 0 : Math.max(0, totalCount - visibleCount);

	return {
		groups,
		totalCount,
		visibleCount,
		hiddenCount,
	};
}
