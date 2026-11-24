export type PersonaRole = "user" | "account-admin" | "super-admin";

export function normalizePersonaRole(role: string | undefined): PersonaRole {
	if (role === "super-admin") return "super-admin";
	if (role === "account-admin") return "account-admin";
	return "user";
}

export function defaultRouteForRole(role: string | undefined): string {
	const persona = normalizePersonaRole(role);
	if (persona === "super-admin") return "/system";
	if (persona === "account-admin") return "/admin";
	return "/bots";
}

/**
 * Strips any `/app` basepath prefix so route-guard checks work on raw router
 * pathnames as well as full browser paths.
 */
function normalizePathname(pathname: string): string {
	let path = pathname.trim() || "/";
	if (path === "/app") return "/";
	if (path.startsWith("/app/")) {
		path = path.slice("/app".length);
	}
	if (path.length > 1 && path.endsWith("/")) {
		path = path.slice(0, -1);
	}
	return path;
}

export function isRouteAllowedForRole(
	pathname: string,
	role: string | undefined,
): boolean {
	const path = normalizePathname(pathname);
	if (path === "/") return true;
	const persona = normalizePersonaRole(role);
	if (persona === "super-admin") {
		return path === "/system" || path.startsWith("/system/");
	}
	if (persona === "account-admin") {
		return path === "/admin" || path.startsWith("/admin/");
	}
	return (
		path === "/bots" ||
		path.startsWith("/bot/") ||
		path === "/schedules" ||
		path === "/envs" ||
		path === "/skills" ||
		path === "/search"
	);
}
