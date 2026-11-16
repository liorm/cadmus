import { useElevation } from "@/context/ElevationContext";

const buttonClass = "min-h-tap rounded-md border border-border px-3";

/**
 * The way out of an "admin mode needed" refusal. Shows the enable error from
 * the shared elevation state, and a check-again action when the state could
 * not be read, so a failed enable never leaves the page silent.
 */
export function ElevationHelp({
	needed,
	onEnabled,
}: {
	needed: boolean;
	onEnabled: () => void;
}) {
	const elevation = useElevation();
	if (!elevation.eligible) return null;
	const unreadable = elevation.until === "unreadable";
	if (!needed && !elevation.error && !unreadable) return null;
	return (
		<div className="flex flex-col gap-2">
			{elevation.error ? (
				<p role="alert" className="text-destructive">
					{elevation.error}
				</p>
			) : null}
			{unreadable ? (
				<p role="alert" className="text-destructive">
					Could not read admin mode.
				</p>
			) : null}
			{typeof elevation.until === "number" ? null : (
				<div className="flex flex-wrap gap-2">
					{needed ? (
						<button
							type="button"
							className={buttonClass}
							disabled={elevation.busy}
							onClick={() => {
								void elevation.toggle(true).then((ok) => {
									if (ok) onEnabled();
								});
							}}
						>
							Turn on admin mode
						</button>
					) : null}
					{unreadable ? (
						<button
							type="button"
							className={buttonClass}
							onClick={elevation.recheck}
						>
							Check again
						</button>
					) : null}
				</div>
			)}
		</div>
	);
}
