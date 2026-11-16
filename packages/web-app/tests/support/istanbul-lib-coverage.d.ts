// The package ships no types and the repo does not depend on @types for it.
// This declares only what tests/support/coverage.ts uses.
declare module "istanbul-lib-coverage" {
	export type CoverageMapData = Record<string, unknown>;
	export interface CoverageMap {
		merge(data: CoverageMapData | CoverageMap): void;
		files(): string[];
	}
}
