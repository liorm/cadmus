import { cadmusPlaywright } from "./tests/support/playwright-shared.ts";

/** Evidence capture. The launcher sets CADMUS_TEST_ENGINE=chrome before this loads. */
export default cadmusPlaywright("./tests/screens", {
	testMatch: "**/*.screens.ts",
	fullyParallel: false,
	workers: 1,
	retries: 0,
});
