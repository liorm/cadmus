/** Page global installed by tests/support/scoped-resource-harness.tsx. */
interface ScopedResourceHarness {
	deferreds: Array<{
		resolve: (value: string) => void;
		reject: (error: Error) => void;
	}>;
	retry: () => number;
	setScope: (scope: string) => void;
	state: () => {
		phase: string;
		data: string | undefined;
		error: string | undefined;
		completed: number;
	};
}

interface Window {
	__h: ScopedResourceHarness;
}
