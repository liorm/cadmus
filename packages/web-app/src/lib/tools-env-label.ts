import type { ToolsEnvSetting } from "@cadmus/contract/types";

/** Row copy: "On · home-pi", "Inherit", or "Off". */
export function toolsEnvLabel(
	setting: ToolsEnvSetting | undefined,
	envNames?: Readonly<Record<string, string>>,
): string {
	if (setting == null) return "Inherit";
	if (!setting.enabled) return "Off";
	const envId = setting.binding?.envId;
	if (!envId) return "On";
	const name = envNames?.[envId]?.trim() || envId;
	return `On · ${name}`;
}
