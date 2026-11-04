import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
import { cn } from "@/lib/utils";

const buttonVariants = cva(
	"inline-flex min-h-tap min-w-tap items-center justify-center gap-2 rounded-md px-4 text-[length:var(--fs-md)] font-medium transition-opacity disabled:opacity-50",
	{
		variants: {
			variant: {
				filled: "bg-accent text-on-accent",
				outlined: "border border-border bg-transparent text-text",
				danger: "border border-status-failed bg-transparent text-status-failed",
				ghost: "bg-transparent text-text",
			},
		},
		defaultVariants: {
			variant: "filled",
		},
	},
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
	VariantProps<typeof buttonVariants> & {
		asChild?: boolean;
	};

export function Button({
	className,
	variant,
	asChild = false,
	type = "button",
	...props
}: ButtonProps) {
	const Comp = asChild ? Slot : "button";
	return (
		<Comp
			className={cn(buttonVariants({ variant }), className)}
			type={asChild ? undefined : type}
			{...props}
		/>
	);
}

export { buttonVariants };
