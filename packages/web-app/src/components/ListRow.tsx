import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function ListRow({
	children,
	onClick,
	unread,
	trailing,
	className,
}: {
	children: ReactNode;
	onClick?: () => void;
	unread?: boolean;
	trailing?: ReactNode;
	className?: string;
}) {
	const Comp = onClick ? "button" : "div";
	return (
		<Comp
			type={onClick ? "button" : undefined}
			aria-label={typeof children === "string" ? children : undefined}
			onClick={onClick}
			className={cn(
				"flex min-h-tap w-full items-center gap-3 border-b border-border px-4 text-left",
				unread ? "font-semibold" : "font-normal",
				className,
			)}
		>
			<span className="min-w-0 flex-1">{children}</span>
			{trailing}
		</Comp>
	);
}
