import { createRoot } from "react-dom/client";
import { useScopedResource } from "@/hooks/useScopedResource";

/**
 * Browser harness for the real useScopedResource hook under real React.
 * Each loader call waits on a deferred the test settles by hand.
 */
interface Deferred {
	resolve: (value: string) => void;
	reject: (error: Error) => void;
}

interface Harness {
	deferreds: Deferred[];
	retry: () => number;
	setScope: (scope: string) => void;
	state: () => {
		phase: string;
		data: string | undefined;
		error: string | undefined;
		completed: number;
	};
}

declare global {
	interface Window {
		__h: Harness;
	}
}

let latest: ReturnType<typeof useScopedResource<string>>;

function Probe({ scope }: { scope: string }) {
	latest = useScopedResource<string>(scope, () => {
		return new Promise<string>((resolve, reject) => {
			window.__h.deferreds.push({ resolve, reject });
		});
	});
	return (
		<output id="out">
			{latest.phase}|{latest.data ?? "-"}|{latest.error ?? "-"}|
			{latest.completed}
		</output>
	);
}

const root = createRoot(document.getElementById("root") as HTMLElement);
const render = (scope: string) => root.render(<Probe scope={scope} />);
window.__h = {
	deferreds: [],
	retry: () => latest.retry(),
	setScope: (scope) => render(scope),
	state: () => ({
		phase: latest.phase,
		data: latest.data,
		error: latest.error,
		completed: latest.completed,
	}),
};
render("a");
