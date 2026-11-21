export const DEVICE_CODE_STORAGE_KEY = "cadmus.deviceCode";

export function deviceCodeFromLocation(
	pathname: string,
	search: string | URLSearchParams,
	stored: string | null,
): string | null {
	const params =
		typeof search === "string" ? new URLSearchParams(search) : search;
	if (pathname === "/login/device") {
		const code = params.get("code")?.trim();
		if (code) return code;
		const saved = stored?.trim();
		return saved ? saved : null;
	}
	if (params.get("auth_error")?.trim()) {
		const saved = stored?.trim();
		return saved ? saved : null;
	}
	return null;
}

export function rememberDeviceCode(code: string): void {
	try {
		sessionStorage.setItem(DEVICE_CODE_STORAGE_KEY, code);
	} catch {
		// Storage unavailable.
	}
}

export function readStoredDeviceCode(): string | null {
	try {
		return sessionStorage.getItem(DEVICE_CODE_STORAGE_KEY);
	} catch {
		return null;
	}
}

export function clearDeviceCode(): void {
	try {
		sessionStorage.removeItem(DEVICE_CODE_STORAGE_KEY);
	} catch {
		// Storage unavailable.
	}
}
