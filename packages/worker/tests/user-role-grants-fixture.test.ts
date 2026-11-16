import { ROLE_GRANTS } from "@cadmus/contract/grants";
import { describe, expect, it } from "vitest";
import fixtureSource from "../../web-app/tests/support/fixtures.ts?raw";

// The web-app UI fixture signs in with a PAT holding the user role's grants.
// The web app may not import the contract's grants, so it keeps a literal; this
// test fails if that literal drifts from the contract.
describe("web-app user sign-in fixture grants", () => {
	it("USER_ROLE_GRANTS equals the contract's user role grants", () => {
		const src: string = fixtureSource;
		const match = /export const USER_ROLE_GRANTS = \[([^\]]*)\]/.exec(src);
		expect(match).not.toBeNull();
		const literal = [...(match?.[1] ?? "").matchAll(/"([^"]+)"/g)].map(
			(m) => m[1],
		);
		expect([...literal].sort()).toEqual([...ROLE_GRANTS.user].sort());
	});
});
