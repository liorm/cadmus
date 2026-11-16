import { useEffect, useState } from "react";

const DESKTOP_VIEWPORT_QUERY = "(min-width: 768px)";

export function useDesktopViewport(): boolean {
	const [matches, setMatches] = useState(() =>
		typeof window !== "undefined" && typeof window.matchMedia === "function"
			? window.matchMedia(DESKTOP_VIEWPORT_QUERY).matches
			: false,
	);

	useEffect(() => {
		if (typeof window.matchMedia !== "function") return;
		const media = window.matchMedia(DESKTOP_VIEWPORT_QUERY);
		const update = () => {
			setMatches(media.matches);
		};
		update();
		media.addEventListener("change", update);
		return () => {
			media.removeEventListener("change", update);
		};
	}, []);

	return matches;
}
