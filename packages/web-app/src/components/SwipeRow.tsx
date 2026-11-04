import { type ReactNode, useEffect, useRef, useState } from "react";

const THRESHOLD = 56;
const REVEAL = 88;

export function SwipeRow({
	children,
	onArchive,
	archiveLabel = "Archive",
	disabled,
}: {
	children: ReactNode;
	onArchive: () => void;
	archiveLabel?: string;
	disabled?: boolean;
}) {
	const rowRef = useRef<HTMLDivElement>(null);
	const offsetRef = useRef(0);
	const [offset, setOffset] = useState(0);

	function moveTo(next: number) {
		offsetRef.current = next;
		setOffset(next);
	}

	useEffect(() => {
		const node = rowRef.current;
		if (!node || disabled) return;
		let startX = 0;
		let startY = 0;
		let tracking = false;
		const captured = (event: PointerEvent) => {
			try {
				return node.hasPointerCapture(event.pointerId);
			} catch {
				return false;
			}
		};
		const onDown = (event: PointerEvent) => {
			startX = event.clientX;
			startY = event.clientY;
			tracking = true;
		};
		const onMove = (event: PointerEvent) => {
			if (!tracking) return;
			const deltaX = event.clientX - startX;
			const deltaY = event.clientY - startY;
			if (!captured(event)) {
				if (!(Math.abs(deltaX) > 8 && Math.abs(deltaX) > Math.abs(deltaY)))
					return;
				try {
					node.setPointerCapture(event.pointerId);
				} catch {
					// Synthetic pointer events used in UI tests have no active pointer.
				}
			}
			const next = Math.min(0, Math.max(-REVEAL, deltaX));
			offsetRef.current = next;
			setOffset(next);
		};
		const onUp = (event: PointerEvent) => {
			if (!tracking) return;
			tracking = false;
			if (captured(event)) {
				try {
					node.releasePointerCapture(event.pointerId);
				} catch {
					// Ignore release when the pointer was never captured.
				}
			}
			const next = offsetRef.current < -THRESHOLD ? -REVEAL : 0;
			offsetRef.current = next;
			setOffset(next);
		};
		node.addEventListener("pointerdown", onDown);
		node.addEventListener("pointermove", onMove);
		node.addEventListener("pointerup", onUp);
		node.addEventListener("pointercancel", onUp);
		return () => {
			node.removeEventListener("pointerdown", onDown);
			node.removeEventListener("pointermove", onMove);
			node.removeEventListener("pointerup", onUp);
			node.removeEventListener("pointercancel", onUp);
		};
	}, [disabled]);

	const revealed = offset < -THRESHOLD;
	return (
		<div className="relative overflow-hidden touch-pan-y">
			<button
				type="button"
				tabIndex={revealed ? 0 : -1}
				aria-hidden={!revealed}
				aria-label={archiveLabel}
				onClick={() => {
					moveTo(0);
					onArchive();
				}}
				className="absolute inset-y-0 right-0 flex w-[88px] items-center justify-center bg-surface-raised text-[length:var(--fs-sm)] text-text-muted"
			>
				Archive
			</button>
			<div
				ref={rowRef}
				className="relative bg-surface touch-pan-y"
				style={{ transform: `translateX(${offset}px)` }}
			>
				{children}
			</div>
		</div>
	);
}
