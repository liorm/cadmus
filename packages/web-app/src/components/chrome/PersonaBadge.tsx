import { normalizePersonaRole, type PersonaRole } from "@/lib/persona-routing";
import { cn } from "@/lib/utils";

const META: Record<
	PersonaRole,
	{ label: string; badgeClass: string; dotClass: string }
> = {
	"super-admin": {
		label: "Super Admin",
		badgeClass:
			"border-status-failed/40 bg-status-failed/12 text-status-failed",
		dotClass: "bg-status-failed",
	},
	"account-admin": {
		label: "Account Admin",
		badgeClass:
			"border-status-needs-you/40 bg-status-needs-you/12 text-status-needs-you",
		dotClass: "bg-status-needs-you",
	},
	user: {
		label: "User",
		badgeClass: "border-accent/40 bg-accent/12 text-accent",
		dotClass: "bg-accent",
	},
};

export function PersonaBadge({
	persona: personaRole,
	className,
}: {
	persona: string | undefined;
	className?: string;
}) {
	const normalized = normalizePersonaRole(personaRole);
	const meta = META[normalized];
	return (
		<span
			className={cn(
				"inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium tracking-tight",
				meta.badgeClass,
				className,
			)}
		>
			<span className={cn("h-1.5 w-1.5 rounded-full", meta.dotClass)} />
			{meta.label}
		</span>
	);
}
