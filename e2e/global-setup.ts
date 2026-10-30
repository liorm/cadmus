import { startCliBridge } from "./cli-bridge-host.js";
import { startDaemonBridge } from "./daemon-bridge-host.js";
import { DAEMON_BRIDGE_HOST } from "./daemon-bridge-port.js";

/**
 * The bridge exists for `tools-env-user-flow.test.ts`. A Vitest invocation
 * that names other files (for example `test:conformance`) does not start it.
 * A run with no file filter includes that test, so the bridge starts.
 * Ports are published through Vitest `provide` and applied as test bindings.
 */
function runNeedsDaemonBridge(): boolean {
	const files = process.argv.filter((arg) => arg.includes(".test.ts"));
	if (files.length === 0) return true;
	return files.some((file) => file.includes("tools-env-user-flow"));
}

export default async function setup(project: {
	provide: (key: string, value: string | number) => void;
}): Promise<() => Promise<void>> {
	const cliBridge = await startCliBridge();
	project.provide("cliBridgePort", cliBridge.port);
	if (!runNeedsDaemonBridge()) {
		project.provide("daemonBridgeHost", "");
		project.provide("daemonBridgePort", 0);
		project.provide("daemonBridgeEventPort", 0);
		return async () => {
			await cliBridge.close();
		};
	}
	const bridge = await startDaemonBridge();
	project.provide("daemonBridgeHost", DAEMON_BRIDGE_HOST);
	project.provide("daemonBridgePort", bridge.port);
	project.provide("daemonBridgeEventPort", bridge.eventPort);
	return async () => {
		await cliBridge.close();
		await bridge.close();
	};
}
