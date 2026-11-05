import type { FamilyRecord } from "@cadmus/contract/types";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { fieldClass } from "@/components/SettingsRows";
import { LoadGate } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useScopedResource } from "@/hooks/useScopedResource";

export function FamilySettingsPage() {
	const { client, familyId, switchFamily, bots } = useCadmus();
	const [name, setName] = useState("");
	const [timezone, setTimezone] = useState("UTC");
	const [harvestDelayMs, setHarvestDelayMs] = useState("60000");
	const [newName, setNewName] = useState("");
	const [newId, setNewId] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	const loaded = useScopedResource(familyId, async () => {
		const res = await client.callRpc<{ families?: FamilyRecord[] }>(
			"family.list",
		);
		if (!res.ok)
			throw new Error(res.error?.message ?? "Could not load families");
		return res.result?.families ?? [];
	});
	const families = loaded.data ?? [];
	const current = families.find((family) => family.familyId === familyId);
	useEffect(() => {
		if (!current) return;
		setName(current.name);
		setTimezone(current.timezone);
		setHarvestDelayMs(String(current.harvestDelayMs));
	}, [current]);
	const formDisabled = busy || loaded.phase !== "ready";

	return (
		<AppShell title="Family" backTo="/settings">
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
				{loaded.phase !== "ready" ? (
					<LoadGate
						phase={loaded.phase}
						error={loaded.error}
						onRetry={loaded.retry}
						label="Loading families"
					>
						{null}
					</LoadGate>
				) : null}
				{error ? <p className="text-destructive">{error}</p> : null}
				{loaded.phase === "ready" ? (
					<ul className="overflow-hidden rounded-md border border-border bg-surface">
						{families.map((family) => {
							const active = family.familyId === familyId;
							return (
								<li
									key={family.familyId}
									className="flex min-h-tap items-center gap-2 border-b border-border px-3 last:border-b-0"
								>
									<span className="min-w-0 flex-1">
										<span className="block truncate font-semibold">
											{family.name}
										</span>
										<span className="block truncate text-[length:var(--fs-sm)] text-text-muted">
											{family.familyId}
											{active ? " · current" : ""}
										</span>
									</span>
									{active ? null : (
										<button
											type="button"
											className="min-h-tap px-2 text-accent"
											onClick={() => void switchFamily(family.familyId)}
										>
											Switch
										</button>
									)}
								</li>
							);
						})}
					</ul>
				) : null}
				<form
					aria-label="Rename family"
					className="flex flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						setBusy(true);
						setError(null);
						const delay = Number(harvestDelayMs);
						void client
							.callRpc("family.update", {
								familyId,
								name: name.trim(),
								timezone: timezone.trim(),
								harvestDelayMs:
									Number.isFinite(delay) && delay > 0 ? delay : undefined,
							})
							.then((res) => {
								if (!res.ok) {
									setError(res.error?.message ?? "Could not update the family");
									return;
								}
								loaded.retry();
							})
							.catch((err: unknown) => {
								setError(err instanceof Error ? err.message : "Network error");
							})
							.finally(() => setBusy(false));
					}}
				>
					<h2 className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
						This family
					</h2>
					<label className="flex flex-col gap-1">
						<span>Display name</span>
						<input
							aria-label="Family name"
							className={fieldClass}
							value={name}
							onChange={(event) => setName(event.target.value)}
							disabled={formDisabled}
							required
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span>Timezone</span>
						<input
							aria-label="Family timezone"
							className={fieldClass}
							value={timezone}
							disabled={formDisabled}
							onChange={(event) => setTimezone(event.target.value)}
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span>Idle harvest delay (ms)</span>
						<input
							aria-label="Harvest delay"
							className={fieldClass}
							inputMode="numeric"
							value={harvestDelayMs}
							disabled={formDisabled}
							onChange={(event) => setHarvestDelayMs(event.target.value)}
						/>
					</label>
					{loaded.phase === "ready" ? (
						<p className="text-[length:var(--fs-sm)] text-text-muted">
							{current?.doName ??
								`cadmus:${current?.accountId ?? ""}:${familyId}`}
							{" · "}
							{bots.length} {bots.length === 1 ? "bot" : "bots"}
						</p>
					) : null}
					<button
						type="submit"
						className="min-h-tap rounded-md bg-accent text-on-accent"
						disabled={formDisabled}
					>
						Save family
					</button>
					<button
						type="button"
						className="min-h-tap rounded-md border border-destructive text-destructive"
						disabled={formDisabled || families.length < 2}
						onClick={() => {
							if (!window.confirm(`Delete family ${name || familyId}?`)) return;
							setBusy(true);
							setError(null);
							void client
								.callRpc("family.delete", { familyId })
								.then(async (res) => {
									if (!res.ok) {
										setError(
											res.error?.message ?? "Could not delete the family",
										);
										return;
									}
									const listed = await client.callRpc<{
										families?: FamilyRecord[];
									}>("family.list");
									const next = listed.result?.families?.[0];
									if (next) await switchFamily(next.familyId);
								})
								.catch((err: unknown) => {
									setError(
										err instanceof Error ? err.message : "Network error",
									);
								})
								.finally(() => setBusy(false));
						}}
					>
						Delete family
					</button>
				</form>
				<form
					aria-label="Create family"
					className="flex flex-col gap-2"
					onSubmit={(event) => {
						event.preventDefault();
						if (!newName.trim()) return;
						setBusy(true);
						setError(null);
						void client
							.callRpc<{ family?: FamilyRecord }>("family.create", {
								name: newName.trim(),
								familyId: newId.trim() || undefined,
								timezone: timezone.trim() || undefined,
							})
							.then(async (res) => {
								if (!res.ok || !res.result?.family) {
									setError(res.error?.message ?? "Could not create the family");
									return;
								}
								setNewName("");
								setNewId("");
								await switchFamily(res.result.family.familyId);
							})
							.catch((err: unknown) => {
								setError(err instanceof Error ? err.message : "Network error");
							})
							.finally(() => setBusy(false));
					}}
				>
					<h2 className="text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted">
						New family
					</h2>
					<label className="flex flex-col gap-1">
						<span>Name</span>
						<input
							aria-label="New family name"
							className={fieldClass}
							value={newName}
							onChange={(event) => setNewName(event.target.value)}
						/>
					</label>
					<label className="flex flex-col gap-1">
						<span>Family ID</span>
						<input
							aria-label="New family ID"
							className={fieldClass}
							value={newId}
							onChange={(event) => setNewId(event.target.value)}
						/>
					</label>
					<button
						type="submit"
						className="min-h-tap rounded-md border border-border"
						disabled={busy || !newName.trim()}
					>
						Create family
					</button>
				</form>
			</div>
		</AppShell>
	);
}
