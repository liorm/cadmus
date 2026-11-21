import { useCallback, useEffect, useRef, useState } from "react";
import { DeviceApproveCard } from "@/components/DeviceApproveCard";
import { RolePickerCard } from "@/components/RolePickerCard";
import { SignInCard } from "@/components/SignInCard";
import {
	clearDeviceCode,
	deviceCodeFromLocation,
	readStoredDeviceCode,
	rememberDeviceCode,
} from "@/lib/device-login";
import {
	authErrorMessage,
	resolveLoginStage,
	sanitizeNextPath,
} from "@/lib/login-flow";
import {
	fetchProvidersInfo,
	readMemberships,
	readPrincipal,
	refreshForBoot,
	type SessionMembership,
	type SessionPrincipal,
	type SessionTokens,
	signOut,
} from "@/lib/session";

interface LoginBootState {
	providers: string[];
	tokens: SessionTokens | null;
	principal: SessionPrincipal | null;
	memberships: SessionMembership[];
}

export function App() {
	const searchParams = new URLSearchParams(window.location.search);
	const next = sanitizeNextPath(searchParams.get("next"));
	const authError = authErrorMessage(searchParams.get("auth_error"));

	const [deviceCode] = useState<string | null>(() => {
		const pathname = window.location.pathname;
		const params = new URLSearchParams(window.location.search);
		const code = deviceCodeFromLocation(
			pathname,
			params,
			readStoredDeviceCode(),
		);
		if (pathname === "/login/device" && code) {
			rememberDeviceCode(code);
		} else if (
			pathname !== "/login/device" &&
			!params.get("auth_error")?.trim()
		) {
			clearDeviceCode();
		}
		return code;
	});

	const [bootPhase, setBootPhase] = useState<
		"loading" | "retrying" | "unavailable" | "ready"
	>("loading");
	const [session, setSession] = useState<LoginBootState>({
		providers: [],
		tokens: null,
		principal: null,
		memberships: [],
	});

	const cancelBoot = useRef<(() => void) | null>(null);

	const loadSessionDetails = useCallback(
		async (tokens: SessionTokens, providers: string[]) => {
			let read = await readPrincipal(tokens.accessToken);
			if (read.kind === "unavailable") {
				await new Promise((resolve) => setTimeout(resolve, 150));
				read = await readPrincipal(tokens.accessToken);
			}
			if (read.kind === "unavailable") {
				setBootPhase("unavailable");
				return;
			}
			if (read.kind === "refused") {
				setSession({
					providers,
					tokens: null,
					principal: null,
					memberships: [],
				});
				setBootPhase("ready");
				return;
			}
			const principal = read.principal;
			const memberships = principal.provisional
				? await readMemberships(tokens.accessToken)
				: [];
			setSession({
				providers,
				tokens,
				principal,
				memberships,
			});
			setBootPhase("ready");
		},
		[],
	);

	const startBoot = useCallback(() => {
		cancelBoot.current?.();
		let cancelled = false;
		const abort = new AbortController();
		setBootPhase("loading");
		void (async () => {
			const providersPromise = fetchProvidersInfo();
			const [providersInfo, boot] = await Promise.all([
				providersPromise,
				refreshForBoot(
					abort.signal,
					() => {
						if (!cancelled) setBootPhase("retrying");
					},
					() => providersPromise.then((info) => info.bootRetry),
				),
			]);
			if (cancelled || boot.kind === "cancelled") return;
			const providers = providersInfo.providers;
			if (boot.kind === "unavailable") {
				setBootPhase("unavailable");
				return;
			}
			if (boot.kind === "none") {
				setSession({
					providers,
					tokens: null,
					principal: null,
					memberships: [],
				});
				setBootPhase("ready");
				return;
			}
			await loadSessionDetails(boot.tokens, providers);
		})();
		cancelBoot.current = () => {
			cancelled = true;
			abort.abort();
		};
	}, [loadSessionDetails]);

	useEffect(() => {
		startBoot();
		return () => cancelBoot.current?.();
	}, [startBoot]);

	const stage = resolveLoginStage({
		bootPhase,
		signedIn: Boolean(session.tokens && session.principal),
		provisional: session.principal?.provisional === true,
		deviceCode,
	});

	useEffect(() => {
		if (stage === "redirect-app") {
			window.location.replace(next);
		}
	}, [stage, next]);

	if (stage === "loading" || stage === "redirect-app") {
		return null;
	}

	if (stage === "retrying") {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-bg p-6">
				<p role="status" className="text-[length:var(--fs-sm)] text-text-muted">
					Reconnecting...
				</p>
			</div>
		);
	}

	if (stage === "unavailable") {
		return (
			<div className="flex min-h-dvh items-center justify-center bg-bg p-6">
				<div
					role="alert"
					className="w-full max-w-sm rounded-lg border border-border bg-surface p-6 text-[length:var(--fs-sm)]"
				>
					<p>We could not check your sign-in just now.</p>
					<button
						type="button"
						className="mt-3 block whitespace-nowrap text-accent underline"
						onClick={() => startBoot()}
					>
						Try again
					</button>
				</div>
			</div>
		);
	}

	if (stage === "choose-role" && session.tokens) {
		return (
			<RolePickerCard
				accessToken={session.tokens.accessToken}
				principal={session.principal}
				memberships={session.memberships}
				deviceCode={deviceCode}
				onAssumed={(assumed) => {
					if (deviceCode && assumed.accessToken) {
						void loadSessionDetails(
							{
								accessToken: assumed.accessToken,
								expiresAt: assumed.expiresAt,
							},
							session.providers,
						);
						return;
					}
					window.location.assign(next);
				}}
				onSignOut={() => {
					void signOut(session.tokens?.accessToken).then(() => {
						setSession((prev) => ({
							...prev,
							tokens: null,
							principal: null,
							memberships: [],
						}));
					});
				}}
			/>
		);
	}

	if (stage === "device-approve" && session.tokens && deviceCode) {
		return (
			<DeviceApproveCard
				code={deviceCode}
				accessToken={session.tokens.accessToken}
				principal={session.principal}
			/>
		);
	}

	return (
		<SignInCard
			providers={session.providers}
			deviceCode={deviceCode}
			next={next}
			authError={authError}
			onDevLoginSuccess={(result) => {
				if (result.provisional) {
					void loadSessionDetails(
						{
							accessToken: result.accessToken,
							expiresAt: result.expiresAt,
							provisional: true,
						},
						session.providers,
					);
					return;
				}
				if (deviceCode) {
					void loadSessionDetails(
						{
							accessToken: result.accessToken,
							expiresAt: result.expiresAt,
						},
						session.providers,
					);
					return;
				}
				window.location.assign(next);
			}}
		/>
	);
}
