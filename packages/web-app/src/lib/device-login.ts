export const DEVICE_CODE_STORAGE_KEY = "cadmus.deviceCode";

export type DeviceCeremonyPhase = "none" | "login" | "role" | "approve";

export function deviceCodeFromLocation(
	pathname: string,
	search: unknown,
	stored: string | null,
): string | null {
	if (pathname === "/login/device" && search && typeof search === "object") {
		const code = (search as { code?: unknown }).code;
		if (typeof code === "string" && code.trim().length > 0) return code.trim();
	}
	const saved = stored?.trim();
	return saved ? saved : null;
}

export function deviceCeremonyPhase(input: {
	code: string | null;
	signedIn: boolean;
	provisional: boolean;
}): DeviceCeremonyPhase {
	if (!input.code) return "none";
	if (!input.signedIn) return "login";
	if (input.provisional) return "role";
	return "approve";
}

export function rememberDeviceCode(code: string): void {
	sessionStorage.setItem(DEVICE_CODE_STORAGE_KEY, code);
}

export function readStoredDeviceCode(): string | null {
	return sessionStorage.getItem(DEVICE_CODE_STORAGE_KEY);
}

export function clearDeviceCode(): void {
	sessionStorage.removeItem(DEVICE_CODE_STORAGE_KEY);
}
