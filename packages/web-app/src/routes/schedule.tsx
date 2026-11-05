import type { ScheduleRecord } from "@cadmus/contract/types";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { AppShell } from "@/components/AppShell";
import { ScheduleEdit } from "@/components/ScheduleEdit";
import { LoadError, SkeletonBlock } from "@/components/Skeleton";
import { useCadmus } from "@/context/CadmusContext";
import type { LoadPhase } from "@/lib/load-state";

export function SchedulePage({
	botId,
	id,
	from,
}: {
	botId: string;
	id: string;
	from?: "all";
}) {
	const navigate = useNavigate();
	const { client, bots } = useCadmus();
	const bot = bots.find((entry) => entry.id === botId);
	const creating = id === "new";
	const [schedule, setSchedule] = useState<ScheduleRecord | null>(null);
	const [phase, setPhase] = useState<LoadPhase>(creating ? "ready" : "loading");
	const [error, setError] = useState<string | null>(null);
	const [attempt, setAttempt] = useState(0);

	useEffect(() => {
		void attempt;
		if (creating) {
			setPhase("ready");
			return;
		}
		let cancelled = false;
		setPhase("loading");
		setSchedule(null);
		setError(null);
		void client
			.callRpc<{ schedules?: ScheduleRecord[] }>("schedule.list", { botId })
			.then((res) => {
				if (cancelled) return;
				if (!res.ok) {
					setPhase("error");
					setError(res.error?.message ?? "Could not load schedule");
					return;
				}
				setSchedule(
					res.result?.schedules?.find((item) => item.id === id) ?? null,
				);
				setPhase("ready");
			})
			.catch((err: unknown) => {
				if (cancelled) return;
				setPhase("error");
				setError(
					err instanceof Error ? err.message : "Could not load schedule",
				);
			});
		return () => {
			cancelled = true;
		};
	}, [attempt, botId, client, creating, id]);

	function back() {
		if (from === "all") {
			void navigate({ to: "/settings/schedules" });
			return;
		}
		void navigate({
			to: "/bot/$botId/$tab",
			params: { botId, tab: "schedules" },
		});
	}

	return (
		<AppShell
			title={creating ? "New schedule" : "Schedule"}
			backTo={
				from === "all" ? "/settings/schedules" : `/bot/${botId}/schedules`
			}
		>
			{phase === "loading" ? (
				<SkeletonBlock label="Loading schedule" />
			) : phase === "error" ? (
				<LoadError
					message={error ?? "Could not load schedule"}
					onRetry={() => setAttempt((value) => value + 1)}
				/>
			) : !creating && !schedule ? (
				<p className="px-3 py-4 text-text-muted">Schedule not found.</p>
			) : (
				<ScheduleEdit
					schedule={schedule}
					timeZone={bot?.timezone ?? "UTC"}
					onDelete={
						creating
							? undefined
							: () => {
									void client
										.callRpc("schedule.delete", { id })
										.then(() => back());
								}
					}
					onSave={(draft) => {
						const payload = {
							name: draft.name || undefined,
							text: draft.text,
							enabled: draft.enabled,
							kind: draft.kind,
							input: draft.input,
							target: { mode: "new-chat" as const },
						};
						const call = creating
							? client.callRpc("schedule.create", { botId, ...payload })
							: client.callRpc("schedule.update", {
									id,
									name: payload.name,
									text: payload.text,
									enabled: payload.enabled,
									kind: payload.kind,
									input: payload.input,
								});
						void call.then(() => back());
					}}
				/>
			)}
		</AppShell>
	);
}
