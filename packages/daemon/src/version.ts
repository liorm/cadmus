import daemonPackage from "../package.json" with { type: "json" };

/** `version` from daemon/package.json, bundled into the standalone binary. */
export const DAEMON_VERSION: string = daemonPackage.version;
