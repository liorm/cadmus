import {
	type KeyboardEvent,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import { createPortal } from "react-dom";
import {
	filterTimeZones,
	selectableTimeZone,
	timeZoneOptions,
} from "@/lib/timezones";
import { cn } from "@/lib/utils";

export function TimezoneCombobox({
	value,
	onChange,
	disabled = false,
	label,
	className,
	id,
}: {
	value: string;
	onChange: (zone: string) => void;
	disabled?: boolean;
	label: string;
	className?: string;
	id?: string;
}) {
	const autoId = useId();
	const inputId = id ?? autoId;
	const listId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [open, setOpen] = useState(false);
	const [query, setQuery] = useState("");
	const [active, setActive] = useState(0);
	const [box, setBox] = useState<{
		top: number;
		left: number;
		width: number;
	} | null>(null);
	const zones = useMemo(() => timeZoneOptions(value), [value]);
	const matches = useMemo(
		() => filterTimeZones(zones, open ? query : ""),
		[zones, open, query],
	);
	const activeId =
		open && matches[active] ? `${listId}-opt-${active}` : undefined;

	function indexOfValue() {
		const index = zones.indexOf(value);
		return index >= 0 ? index : 0;
	}

	function openList() {
		if (disabled) return;
		setOpen(true);
		setQuery("");
		setActive(indexOfValue());
	}

	useEffect(() => {
		if (!open) return;
		const place = () => {
			const rect = inputRef.current?.getBoundingClientRect();
			if (!rect) return;
			setBox({ top: rect.bottom + 4, left: rect.left, width: rect.width });
		};
		place();
		window.addEventListener("resize", place);
		window.addEventListener("scroll", place, true);
		return () => {
			window.removeEventListener("resize", place);
			window.removeEventListener("scroll", place, true);
		};
	}, [open]);

	useEffect(() => {
		if (!open || !activeId || !box) return;
		document.getElementById(activeId)?.scrollIntoView({ block: "nearest" });
	}, [open, activeId, box]);

	function close() {
		setOpen(false);
		setQuery("");
		setActive(0);
	}

	function choose(zone: string) {
		const next = selectableTimeZone(zones, zone);
		if (!next) return;
		if (next !== value) onChange(next);
		close();
	}

	function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (disabled) return;
		if (event.key === "ArrowDown" || event.key === "ArrowUp") {
			event.preventDefault();
			if (!open) {
				openList();
				return;
			}
			if (matches.length === 0) return;
			const delta = event.key === "ArrowDown" ? 1 : -1;
			setActive((index) => (index + delta + matches.length) % matches.length);
			return;
		}
		if (event.key === "Escape") {
			event.preventDefault();
			close();
			return;
		}
		if (event.key === "Enter" && open) {
			event.preventDefault();
			const zone = matches[active];
			if (zone) choose(zone);
		}
	}

	return (
		<div className="relative">
			<input
				ref={inputRef}
				id={inputId}
				role="combobox"
				aria-label={label}
				aria-expanded={open}
				aria-controls={listId}
				aria-autocomplete="list"
				aria-activedescendant={activeId}
				className={cn("w-full bg-transparent", className)}
				disabled={disabled}
				value={open ? query : value}
				placeholder={value}
				onChange={(event) => {
					setQuery(event.target.value);
					setActive(0);
					setOpen(true);
				}}
				onFocus={openList}
				onClick={() => {
					if (!open) openList();
				}}
				onBlur={() => {
					close();
				}}
				onKeyDown={onKeyDown}
			/>
			{open && box
				? createPortal(
						<div
							id={listId}
							role="listbox"
							className="fixed z-50 max-h-60 overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-md"
							style={{ top: box.top, left: box.left, width: box.width }}
							onPointerDown={(event) => event.preventDefault()}
						>
							{matches.length === 0 ? (
								<div className="px-3 py-2 text-[length:var(--fs-sm)] text-text-muted">
									No matching timezones
								</div>
							) : (
								matches.map((zone, index) => (
									<div
										key={zone}
										id={`${listId}-opt-${index}`}
										role="option"
										tabIndex={-1}
										aria-selected={index === active}
										className={cn(
											"cursor-pointer px-3 py-2 text-[length:var(--fs-sm)]",
											index === active
												? "bg-accent text-on-accent"
												: "text-text",
										)}
										onMouseEnter={() => setActive(index)}
										onKeyDown={(event) => {
											if (event.key === "Enter" || event.key === " ") {
												event.preventDefault();
												choose(zone);
											}
										}}
										onClick={() => choose(zone)}
									>
										{zone}
									</div>
								))
							)}
						</div>,
						document.body,
					)
				: null}
		</div>
	);
}
