import type {
	AccountRecord,
	CredentialSummary,
	ScheduleRecord,
	ToolsEnvRecord,
} from "@cadmus/contract/types";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { SegmentedControl } from "@/components/SegmentedControl";
import { SettingsLink, SettingsSection } from "@/components/SettingsRows";
import { useCadmus } from "@/context/CadmusContext";
import { getTheme, setTheme, THEMES, type ThemeName } from "@/theme/theme";

export function SettingsPage() {
	const { client, bots, refreshDirectory, teamLeaderBotId } = useCadmus();
	const [theme, setThemeState] = useState<ThemeName>(() => getTheme());
	const [account, setAccount] = useState<AccountRecord | null>(null);
	const [memberCount, setMemberCount] = useState(0);
	const [credentials, setCredentials] = useState<CredentialSummary[]>([]);
	const [envs, setEnvs] = useState<ToolsEnvRecord[]>([]);
	const [scheduleCount, setScheduleCount] = useState(0);
	const [scheduleBots, setScheduleBots] = useState(0);
	const [archiveCount, setArchiveCount] = useState(0);
	const [familyName, setFamilyName] = useState("");
	const [savingLeader, setSavingLeader] = useState(false);
	const [leaderError, setLeaderError] = useState<string | null>(null);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
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
			if (cancelled) return;
			setAccount(accountRes.result?.account ?? null);
			setMemberCount(accountRes.result?.members?.length ?? 0);
			setCredentials(accountRes.result?.credentials ?? []);
			setEnvs(envRes.result?.envs ?? []);
			const schedules = (scheduleRes.result?.schedules ?? []).filter(
				(schedule) => !schedule.internal,
			);
			setScheduleCount(schedules.length);
			setScheduleBots(
				new Set(schedules.map((schedule) => schedule.botId)).size,
			);
			setArchiveCount(
				(chatRes.result?.chats ?? []).filter((chat) => chat.closed).length,
			);
			setFamilyName(familyRes.result?.family?.name ?? "");
		})();
		return () => {
			cancelled = true;
		};
	}, [client]);

	const connected = credentials.map((item) => item.providerId);
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
				<SettingsSection title="Account">
					<SettingsLink
						to="/settings/account"
						title={account?.name || "Account"}
						hint={
							account
								? `${account.timezone} · ${memberCount} ${memberCount === 1 ? "member" : "members"}`
								: "Name, timezone, and members"
						}
					/>
				</SettingsSection>
				<SettingsSection title="Family">
					<SettingsLink
						to="/settings/family"
						title={familyName || "Family"}
						hint={`${memberCount} ${memberCount === 1 ? "member" : "members"} · ${bots.length} ${bots.length === 1 ? "bot" : "bots"}`}
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
							disabled={savingLeader}
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
						hint={scheduleHint}
					/>
				</SettingsSection>
				<SettingsSection title="Providers">
					<SettingsLink
						to="/settings/providers"
						title="AI providers"
						hint={providerHint}
					/>
				</SettingsSection>
				<SettingsSection title="Tools environments">
					<SettingsLink
						to="/settings/tools"
						title="Tools environments"
						hint={
							envs.length === 0
								? "None yet"
								: `${envs.length} ${envs.length === 1 ? "environment" : "environments"}`
						}
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
						hint={
							archiveCount === 0
								? "No archived chats · read-only"
								: `${archiveCount} archived ${archiveCount === 1 ? "chat" : "chats"} · read-only`
						}
					/>
				</SettingsSection>
			</div>
		</AppShell>
	);
}
