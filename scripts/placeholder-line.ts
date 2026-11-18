/** One input line whose suggestion is dim until the first typed character. */

const DIM = "\u001b[90m";
const RESET = "\u001b[0m";

export interface PlaceholderLine {
	typed: string;
	placeholder: string;
}

export function dimPlaceholder(placeholder: string): string {
	return `${DIM}${placeholder}${RESET}`;
}

/**
 * `paint` is what the terminal should write. Enter accepts the typed text,
 * or the placeholder when nothing was typed. Backspacing the last character
 * restores the gray suggestion.
 */
export function applyPlaceholderKey(
	state: PlaceholderLine,
	key: string,
): { state: PlaceholderLine; paint: string; done: boolean; value?: string } {
	if (key === "\r" || key === "\n") {
		const value = state.typed.length > 0 ? state.typed : state.placeholder;
		return { state, paint: "\n", done: true, value };
	}
	if (key === "\u007f" || key === "\b") {
		if (state.typed.length === 0) return { state, paint: "", done: false };
		const typed = state.typed.slice(0, -1);
		const paint =
			typed.length === 0
				? `\b \b${dimPlaceholder(state.placeholder)}`
				: "\b \b";
		return { state: { ...state, typed }, paint, done: false };
	}
	if (key.length !== 1 || key < " ") return { state, paint: "", done: false };
	if (state.typed.length === 0) {
		const width = state.placeholder.length;
		const clear = `${"\b".repeat(width)}${" ".repeat(width)}${"\b".repeat(width)}`;
		return {
			state: { ...state, typed: key },
			paint: clear + key,
			done: false,
		};
	}
	return {
		state: { ...state, typed: state.typed + key },
		paint: key,
		done: false,
	};
}
