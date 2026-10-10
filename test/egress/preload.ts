// `bun --preload test/egress/preload.ts …` routes a child process's egress to the FakeEgress at EGRESS_URL.
import { routeEgress } from "./route.ts";

if (!process.env.EGRESS_URL)
	throw new Error("EGRESS_URL is required by the egress preload");
routeEgress(process.env.EGRESS_URL);
