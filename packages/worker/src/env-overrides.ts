/**
 * Shared helpers for parsing clamped numeric environment overrides and checking
 * production deployment markers.
 */

/**
 * True only for the string `"production"` (case-insensitive, trimmed). Accepts
 * `unknown` because `CADMUS_ENV` may be a Durable Object binding object rather
 * than a string marker.
 */
export function isProductionDeploy(value: unknown): boolean {
	return (
		typeof value === "string" && value.trim().toLowerCase() === "production"
	);
}

/**
 * Parses `raw` as a finite number, rounds it to an integer, and clamps it to
 * `[min, max]`. Returns `null` when `raw` is unset, blank, or non-numeric.
 */
export function parseClampedInt(
	raw: string | undefined,
	min: number,
	max: number,
): number | null {
	if (raw === undefined) return null;
	const trimmed = raw.trim();
	if (trimmed === "") return null;
	const value = Number(trimmed);
	if (!Number.isFinite(value)) return null;
	const rounded = Math.round(value);
	if (rounded < min) return min;
	if (rounded > max) return max;
	return rounded;
}

/**
 * Parses a test-only integer override clamped to `[min, max]`. Returns `null`
 * when `deployEnv` is `"production"` so production deployments always ignore
 * test-only bindings.
 */
export function resolveClampedTestInt(
	raw: string | undefined,
	deployEnv: unknown,
	min: number,
	max: number,
): number | null {
	if (isProductionDeploy(deployEnv)) return null;
	return parseClampedInt(raw, min, max);
}
