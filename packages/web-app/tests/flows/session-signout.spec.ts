import { test } from "../support/fixtures.ts";
import { sessionSignoutScenario } from "../support/session-signout.ts";

// Signs in on its own (or not at all); no master dev config is seeded.
test.use({ signIn: "none" });

test.describe.configure({ mode: "parallel" });

test("a real signed-in session boots, never stores its token, and sign-out kills it server side (flows)", async ({
	page,
	playwright,
	accountId,
	baseURL,
}) => {
	await sessionSignoutScenario(
		page,
		playwright,
		accountId,
		baseURL ?? "http://127.0.0.1:8799",
	);
});
