import { useCadmus } from "@/context/CadmusContext";

export function ReconnectBar() {
	const { connectionStatus, skipTenantSync } = useCadmus();
	if (skipTenantSync || connectionStatus === "connected") return null;
	return (
		<div
			role="status"
			className="flex items-center justify-center gap-2 border-b border-status-needs-you/40 bg-status-needs-you/15 px-3 py-1.5 text-[length:var(--fs-sm)] font-medium text-status-needs-you"
		>
			<span
				aria-hidden="true"
				className="cadmus-spin inline-block size-3.5 rounded-full border-2 border-current border-t-transparent"
			/>
			Reconnecting… live updates paused
		</div>
	);
}
