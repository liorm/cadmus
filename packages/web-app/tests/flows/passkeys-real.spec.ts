import { test } from "../support/fixtures.ts";
import {
	passkeyLifecycleScenario,
	passkeyReplayAndRefusalsScenario,
	secondPasskeyRequiresAdminModeScenario,
	staleGoogleCannotEnrollScenario,
	unsupportedBrowserPasskeyScenario,
} from "../support/passkeys-real.ts";

// Real ceremony: Chrome's virtual authenticator against the real worker. No
// navigator or API stubs. It needs the Chrome engine (CDP WebAuthn).
test.skip(
	(process.env.CADMUS_TEST_ENGINE ?? "obscura").toLowerCase() !== "chrome",
	"needs real Chrome for the CDP virtual authenticator",
);
test.use({ signIn: "none" });
test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

test("first passkey, admin mode by passkey, a second passkey, then a removal, on the real backend (flows)", async ({
	page,
	context,
}, testInfo) => {
	await passkeyLifecycleScenario(page, context, testInfo);
});

test("a stale Google sign-in cannot enrol the first passkey (flows)", async ({
	page,
	context,
}) => {
	await staleGoogleCannotEnrollScenario(page, context);
});

test("a second passkey without admin mode is refused, and the last removal ends admin mode (flows)", async ({
	page,
	context,
}) => {
	await secondPasskeyRequiresAdminModeScenario(page, context);
});

test("the real challenge row, a replayed finish, a foreign remove and a generic revoke (flows)", async ({
	page,
	context,
}, testInfo) => {
	await passkeyReplayAndRefusalsScenario(page, context, testInfo);
});

test("a browser without passkey support says so and cannot add one (flows)", async ({
	page,
	context,
}, testInfo) => {
	await unsupportedBrowserPasskeyScenario(page, context, testInfo);
});
