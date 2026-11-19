import type {
	AccountRecord,
	CredentialSummary,
	ScheduleRecord,
	ToolsEnvRecord,
} from "@cadmus/contract/types";
import { useState } from "react";
import { AppShell } from "@/components/AppShell";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SettingsLink, SettingsSection } from "@/components/SettingsRows";
import { HintSkeleton, LoadError } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import { useSession } from "@/context/SessionContext";
import { useScopedResource } from "@/hooks/useScopedResource";
import { getTheme, setTheme, THEMES, type ThemeName } from "@/theme/theme";

export function SettingsPage() {
	const {
		client,
		bots,
		refreshDirectory,
		teamLeaderBotId,
		directoryReady,
		familyId,
		skipTenantSync,
	} = useCadmus();
	const session = useSession();
	const superAdmin =
		session.principal?.kind === "user" &&
		session.principal.role === "super-admin";
	const [theme, setThemeState] = useState<ThemeName>(() => getTheme());
	const [savingLeader, setSavingLeader] = useState(false);
	const [leaderError, setLeaderError] = useState<string | null>(null);
	const hub = useScopedResource(
		skipTenantSync ? `${familyId}:system` : familyId,
		async () => {
			if (skipTenantSync) {
				return {
					account: null,
					memberCount: 0,
					credentials: [],
					envs: [],
					scheduleCount: 0,
					scheduleBots: 0,
					archiveCount: 0,
					familyName: "",
				};
			}
			const [accountRes, envRes, scheduleRes, chatRes, familyRes] =
				await Promise.all([
					client.callRpc<{
						account?: AccountRecord;
						members?: unknown[];
						credentials?: CredentialSummary[];
					}>("account.get"),
					client.callRpc<{ envs?: ToolsEnvRecord[] }>("account.toolsEnvs.list"),
					client.callRpc<{ schedules?: ScheduleRecord[] }>("schedule.list"),
					client.callRpc<{ chats?: Array<{ closed?: boolean }> }>("chat.list", {
						kinds: ["direct"],
					}),
					client.callRpc<{ family?: { name?: string } }>("family.get"),
				]);
			if (
				!accountRes.ok ||
				!envRes.ok ||
				!scheduleRes.ok ||
				!chatRes.ok ||
				!familyRes.ok
			) {
				throw new Error(
					accountRes.error?.message ??
						envRes.error?.message ??
						"Could not load settings",
				);
			}
			const schedules = (scheduleRes.result?.schedules ?? []).filter(
				(schedule) => !schedule.internal,
			);
			return {
				account: accountRes.result?.account ?? null,
				memberCount: accountRes.result?.members?.length ?? 0,
				credentials: accountRes.result?.credentials ?? [],
				envs: envRes.result?.envs ?? [],
				scheduleCount: schedules.length,
				scheduleBots: new Set(schedules.map((schedule) => schedule.botId)).size,
				archiveCount: (chatRes.result?.chats ?? []).filter(
					(chat) => chat.closed,
				).length,
				familyName: familyRes.result?.family?.name ?? "",
			};
		},
	);

	const ready = hub.phase === "ready" && hub.data;
	const account = hub.data?.account ?? null;
	const memberCount = hub.data?.memberCount ?? 0;
	const envs = hub.data?.envs ?? [];
	const scheduleCount = hub.data?.scheduleCount ?? 0;
	const scheduleBots = hub.data?.scheduleBots ?? 0;
	const archiveCount = hub.data?.archiveCount ?? 0;
	const familyName = hub.data?.familyName ?? "";
	const connected = (hub.data?.credentials ?? []).map(
		(item) => item.providerId,
	);
	const hint = (text: string) => (ready ? text : <HintSkeleton />);
	const providerHint =
		connected.length === 0
			? "None connected"
			: `${connected.join(", ")} connected`;
	const scheduleHint =
		scheduleCount === 0
			? "No schedules yet"
			: `${scheduleCount} ${scheduleCount === 1 ? "schedule" : "schedules"} across ${scheduleBots} ${scheduleBots === 1 ? "bot" : "bots"}`;

	async function onLeader(value: string) {
		setSavingLeader(true);
		setLeaderError(null);
		try {
			const res = await client.callRpc("family.update", {
				teamLeaderBotId: value ? value : null,
			});
			if (!res.ok) {
				setLeaderError(
					res.error?.message ?? "Could not update Team Leader bot",
				);
				return;
			}
			await refreshDirectory();
		} catch (err) {
			setLeaderError(err instanceof Error ? err.message : "Network error");
		} finally {
			setSavingLeader(false);
		}
	}

	return (
		<AppShell title="Settings" backTo="/">
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-3 py-4">
				{hub.phase === "error" ? (
					<LoadError
						message={hub.error ?? "Could not load settings"}
						onRetry={hub.retry}
					/>
				) : null}
				<SettingsSection title="Account">
					<SettingsLink
						to="/settings/account"
						title="Account"
						hint={hint(
							account
								? `${account.name} · ${account.timezone} · ${memberCount} ${memberCount === 1 ? "member" : "members"}`
								: "Name, timezone, and members",
						)}
					/>
				</SettingsSection>
				<SettingsSection title="Security">
					<SettingsLink
						to="/settings/security"
						title="Sign-in and sessions"
						hint="Where you are signed in, and how"
					/>
				</SettingsSection>
				{superAdmin ? (
					<SettingsSection title="System">
						<SettingsLink
							to="/system"
							title="System console"
							hint="Accounts, members, sign-ins and audit"
						/>
					</SettingsSection>
				) : null}
				<SettingsSection title="Family">
					<SettingsLink
						to="/settings/family"
						title="Family"
						hint={hint(
							`${familyName || "Family"} · ${memberCount} ${memberCount === 1 ? "member" : "members"} · ${bots.length} ${bots.length === 1 ? "bot" : "bots"}`,
						)}
					/>
				</SettingsSection>
				<SettingsSection title="Bots">
					<label className="flex min-h-tap items-center gap-3 border-b border-border px-4 py-3">
						<span className="min-w-0 flex-1">
							<span className="block font-semibold">Team Leader bot</span>
							<span className="block text-[length:var(--fs-sm)] text-text-muted">
								Team Leader · used by “Let TL route”
							</span>
							{leaderError ? (
								<span className="block text-[length:var(--fs-sm)] text-destructive">
									{leaderError}
								</span>
							) : null}
						</span>
						<select
							aria-label="Team Leader bot"
							className="max-w-[40%] truncate bg-transparent text-[length:var(--fs-sm)]"
							value={teamLeaderBotId ?? ""}
							disabled={savingLeader || !directoryReady}
							onChange={(event) => {
								const next = event.target.value;
								if (next === (teamLeaderBotId ?? "")) return;
								void onLeader(next);
							}}
						>
							<option value="">None</option>
							{bots.map((bot) => (
								<option key={bot.id} value={bot.id}>
									{bot.name}
								</option>
							))}
						</select>
					</label>
					<SettingsLink
						to="/settings/schedules"
						title="All schedules"
						hint={hint(scheduleHint)}
					/>
				</SettingsSection>
				<SettingsSection title="Providers">
					<SettingsLink
						to="/settings/providers"
						title="AI providers"
						hint={hint(providerHint)}
					/>
				</SettingsSection>
				<SettingsSection title="Tools environments">
					<SettingsLink
						to="/settings/tools"
						title="Tools environments"
						hint={hint(
							envs.length === 0
								? "None yet"
								: `${envs.length} ${envs.length === 1 ? "environment" : "environments"}`,
						)}
					/>
				</SettingsSection>
				<section
					aria-labelledby="appearance-heading"
					className="flex flex-col gap-2"
				>
					<h2
						id="appearance-heading"
						className="px-1 text-[length:var(--fs-xs)] font-semibold uppercase tracking-wide text-text-muted"
					>
						Appearance
					</h2>
					<SegmentedControl
						ariaLabel="Theme"
						value={theme}
						onValueChange={(value) => {
							const next = value as ThemeName;
							if (!THEMES.includes(next)) return;
							setTheme(next);
							setThemeState(next);
						}}
						options={THEMES.map((name) => ({
							value: name,
							label: name[0]?.toUpperCase() + name.slice(1),
						}))}
					/>
				</section>
				<SettingsSection title="Data">
					<SettingsLink
						to="/settings/archive"
						title="Archive"
						hint={hint(
							archiveCount === 0
								? "No archived chats · read-only"
								: `${archiveCount} archived ${archiveCount === 1 ? "chat" : "chats"} · read-only`,
						)}
					/>
				</SettingsSection>
			</div>
		</AppShell>
	);
}
