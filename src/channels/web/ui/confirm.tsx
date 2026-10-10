import type { ComponentChildren } from "preact";

export function ConfirmDialog(props: {
	title: string;
	children: ComponentChildren;
	confirmLabel: string;
	onCancel: () => void;
	onConfirm: () => void;
}) {
	return (
		<div class="ov">
			<div
				class="mod"
				role="alertdialog"
				aria-modal="true"
				aria-labelledby="confirm-title"
				style="width:420px"
			>
				<div
					id="confirm-title"
					style="padding:18px 22px 4px;font-size:18px;font-weight:700"
				>
					{props.title}
				</div>
				<div class="mu" style="padding:0 22px 16px;font-size:13px">
					{props.children}
				</div>
				<div style="display:flex;justify-content:flex-end;gap:10px;padding:14px 22px;border-top:1px solid var(--line)">
					<button type="button" class="btn ghost" onClick={props.onCancel}>
						Cancel
					</button>
					<button type="button" class="btn stop" onClick={props.onConfirm}>
						{props.confirmLabel}
					</button>
				</div>
			</div>
		</div>
	);
}
