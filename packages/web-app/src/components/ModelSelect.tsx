import type { ModelInfo, ModelTier } from "@cadmus/contract/types";
import { Check, ChevronDown, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { modelListRef } from "@/lib/model-ref";
import { groupModelsForSelect, providerDisplayName } from "@/lib/model-select";

function TierBadge({ tier }: { tier: ModelTier }) {
	if (tier === "other") return null;
	return (
		<span
			className={
				tier === "frontier"
					? "rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent"
					: "rounded bg-surface-raised px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-text-muted"
			}
		>
			{tier}
		</span>
	);
}

export function ModelSelect({
	ariaLabel,
	models,
	value,
	onChange,
	disabled = false,
	placeholder = "Select a model…",
	triggerClassName = "",
}: {
	ariaLabel: string;
	models: readonly ModelInfo[];
	value: string;
	onChange: (modelRef: string) => void;
	disabled?: boolean;
	placeholder?: string;
	triggerClassName?: string;
}) {
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [showAll, setShowAll] = useState(false);
	const containerRef = useRef<HTMLDivElement>(null);
	const searchInputRef = useRef<HTMLInputElement>(null);

	const selectedModel = useMemo(
		() => models.find((m) => modelListRef(m) === value),
		[models, value],
	);

	const grouped = useMemo(
		() =>
			groupModelsForSelect(models, {
				query,
				showAll,
				selectedRef: value || undefined,
			}),
		[models, query, showAll, value],
	);

	useEffect(() => {
		if (!open) return;
		const timer = setTimeout(() => {
			searchInputRef.current?.focus();
		}, 0);
		const onPointerDown = (event: MouseEvent) => {
			if (!containerRef.current?.contains(event.target as Node)) {
				setOpen(false);
			}
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setOpen(false);
			}
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			clearTimeout(timer);
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	const triggerLabel = selectedModel
		? `${selectedModel.name} (${providerDisplayName(selectedModel.provider)})`
		: value || placeholder;

	return (
		<div ref={containerRef} className="relative">
			<button
				type="button"
				aria-label={ariaLabel}
				aria-haspopup="listbox"
				aria-expanded={open}
				disabled={disabled}
				onClick={() => {
					if (disabled) return;
					setOpen((prev) => !prev);
				}}
				className={`flex min-h-tap w-full items-center justify-between gap-2 rounded-lg border border-border bg-bg px-3 py-1.5 text-left text-sm text-text outline-none transition-colors hover:border-accent/60 focus:border-accent disabled:cursor-not-allowed disabled:opacity-50 ${triggerClassName}`}
			>
				<span className="min-w-0 flex-1 truncate font-medium">
					{triggerLabel}
				</span>
				<ChevronDown
					className={`h-4 w-4 shrink-0 text-text-muted transition-transform ${open ? "rotate-180" : ""}`}
				/>
			</button>

			{open ? (
				<div className="absolute left-0 right-0 z-50 mt-1 overflow-hidden rounded-xl border border-border bg-surface shadow-xl">
					<div className="flex items-center gap-2 border-b border-border px-2.5 py-2">
						<Search className="h-3.5 w-3.5 shrink-0 text-text-muted" />
						<input
							ref={searchInputRef}
							type="text"
							aria-label="Search models"
							placeholder="Search models or providers…"
							value={query}
							onChange={(e) => setQuery(e.target.value)}
							className="w-full bg-transparent text-xs text-text outline-none placeholder:text-text-muted"
						/>
						{query ? (
							<button
								type="button"
								aria-label="Clear model search"
								onClick={() => setQuery("")}
								className="rounded p-0.5 text-text-muted hover:text-text"
							>
								<X className="h-3.5 w-3.5" />
							</button>
						) : null}
					</div>

					<div
						role="listbox"
						aria-label={ariaLabel}
						className="max-h-72 overflow-y-auto p-1"
					>
						{grouped.groups.length === 0 ? (
							<p className="px-3 py-4 text-center text-xs text-text-muted">
								No models match "{query}".
							</p>
						) : (
							grouped.groups.map((group) => (
								<div key={group.provider} className="mb-1 last:mb-0">
									<div className="sticky top-0 z-10 flex items-center justify-between bg-surface/95 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted backdrop-blur-sm">
										<span>{group.label}</span>
										{!group.authenticated ? (
											<span className="font-normal normal-case">no key</span>
										) : null}
									</div>
									{group.items.map((item) => {
										const isSelected = item.ref === value;
										const isDisabled = !item.model.authenticated;
										return (
											<button
												key={item.ref}
												type="button"
												role="option"
												aria-selected={isSelected}
												disabled={isDisabled}
												onClick={() => {
													if (isDisabled) return;
													onChange(item.ref);
													setOpen(false);
													setQuery("");
												}}
												className={`flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors ${
													isSelected
														? "bg-accent/15 text-text"
														: "text-text hover:bg-surface-raised"
												} ${isDisabled ? "cursor-not-allowed opacity-45" : ""}`}
											>
												<div className="min-w-0 flex-1">
													<div className="flex items-center gap-1.5">
														<span className="truncate font-medium">
															{item.model.name}
														</span>
														<TierBadge tier={item.tier} />
													</div>
													<div className="truncate font-mono text-[10px] text-text-muted">
														{item.ref}
													</div>
												</div>
												{isSelected ? (
													<Check className="h-3.5 w-3.5 shrink-0 text-accent" />
												) : null}
											</button>
										);
									})}
								</div>
							))
						)}
					</div>

					{!query.trim() && (grouped.hiddenCount > 0 || showAll) ? (
						<div className="border-t border-border bg-bg/50 px-2.5 py-1.5">
							<button
								type="button"
								onClick={() => setShowAll((prev) => !prev)}
								className="w-full text-center text-[11px] font-medium text-accent hover:underline"
							>
								{showAll
									? "Show popular only"
									: `Show all models (${grouped.totalCount})`}
							</button>
						</div>
					) : null}
				</div>
			) : null}
		</div>
	);
}
