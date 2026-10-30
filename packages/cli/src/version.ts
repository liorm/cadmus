import cliPackage from "../package.json" with { type: "json" };

/** `version` from cli/package.json, bundled into the standalone binary. */
export const CLI_VERSION: string = cliPackage.version;
