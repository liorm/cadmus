import { type Static, Type } from "typebox";

/**
 * Browser sign-in. These commands are public: no grant, and they do not run
 * inside a Bot Family. Google’s redirect cannot post JSON, so the callback is
 * a declared GET path, not a command.
 */
export const AUTH_LOGIN_GOOGLE_CALLBACK_PATH =
	"/api/auth/login/google/callback";

const idField = Type.String({
	minLength: 1,
	description: "Request id.",
});

export const AuthLoginProvidersCommandSchema = Type.Object(
	{
		id: idField,
		type: Type.Literal("auth.login.providers", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		readOnly: true,
		description: "Configured Cadmus sign-in providers. No grant.",
	},
);
export type AuthLoginProvidersCommand = Static<
	typeof AuthLoginProvidersCommandSchema
>;

export const AuthLoginProvidersResultSchema = Type.Object(
	{
		providers: Type.Array(
			Type.Object(
				{ id: Type.String({ description: "Provider id." }) },
				{ description: "One configured sign-in provider." },
			),
		),
		bootRetry: Type.Optional(
			Type.Object(
				{
					waitMs: Type.Optional(Type.Number()),
					retries: Type.Optional(Type.Number()),
				},
				{
					description:
						"How the client retries a session while the worker boots.",
				},
			),
		),
	},
	{ description: "Result payload returned by auth.login.providers." },
);
export type AuthLoginProvidersResult = Static<
	typeof AuthLoginProvidersResultSchema
>;

export const AuthLoginDevPasswordCommandSchema = Type.Object(
	{
		id: idField,
		type: Type.Literal("auth.login.devPassword", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				password: Type.String({ minLength: 1, description: "Local password." }),
				chooseRole: Type.Optional(
					Type.Literal(true, {
						description:
							"Open a 15-minute session on the lowest role when the user holds more than one, so they can assume a role.",
					}),
				),
				email: Type.Optional(
					Type.String({
						description:
							"Email to sign in. When omitted, the configured bootstrap email is used.",
					}),
				),
			},
			{ description: "Local password sign-in." },
		),
	},
	{
		description:
			"Local password sign-in. Refused in production. Refresh token is a cookie.",
	},
);
export type AuthLoginDevPasswordCommand = Static<
	typeof AuthLoginDevPasswordCommandSchema
>;

export const AuthLoginGoogleStartCommandSchema = Type.Object(
	{
		id: idField,
		type: Type.Literal("auth.login.google.start", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		description:
			"Start Google sign-in. GET redirects to Google. Callback is GET /api/auth/login/google/callback.",
	},
);
export type AuthLoginGoogleStartCommand = Static<
	typeof AuthLoginGoogleStartCommandSchema
>;

export const AuthLoginGoogleStartResultSchema = Type.Object(
	{
		authorizationUrl: Type.String({
			description: "Google authorization URL for this transaction.",
		}),
		transactionId: Type.String({
			description: "Transaction id (the OAuth state).",
		}),
	},
	{ description: "Result payload returned by auth.login.google.start." },
);
export type AuthLoginGoogleStartResult = Static<
	typeof AuthLoginGoogleStartResultSchema
>;

export const AuthLoginSessionResultSchema = Type.Object(
	{
		accessToken: Type.String({
			description: "Session access token.",
		}),
		refreshToken: Type.Optional(
			Type.String({
				description:
					"Rotated or newly issued refresh secret. Set on a CLI refresh and a device poll. Browser login and cookie refresh omit it.",
			}),
		),
		expiresAt: Type.Number({ description: "Access token expiry, epoch ms." }),
		provisional: Type.Optional(
			Type.Boolean({
				description:
					"True when this is the short role-choice session. Call auth.assumeRole to open a full session.",
			}),
		),
		sessionId: Type.Optional(Type.String()),
		accountId: Type.Optional(Type.String()),
		userId: Type.Optional(Type.String()),
	},
	{
		description:
			"A Cadmus session. Browser responses omit refreshToken; a CLI refresh and a device poll include it.",
	},
);
export type AuthLoginSessionResult = Static<
	typeof AuthLoginSessionResultSchema
>;

export const AuthSessionRefreshCommandSchema = Type.Object(
	{
		id: idField,
		type: Type.Literal("auth.session.refresh", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object(
				{
					refreshToken: Type.Optional(
						Type.String({
							minLength: 1,
							description:
								"Refresh secret. The browser sends the cookie instead. Not both.",
						}),
					),
				},
				{
					description:
						"Refresh credential. The cookie or refreshToken, not both.",
				},
			),
		),
	},
	{
		description: "Rotate the session from the refresh cookie.",
	},
);
export type AuthSessionRefreshCommand = Static<
	typeof AuthSessionRefreshCommandSchema
>;

export const AuthSessionLogoutCommandSchema = Type.Object(
	{
		id: idField,
		type: Type.Literal("auth.session.logout", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object(
				{
					refreshToken: Type.Optional(
						Type.String({
							minLength: 1,
							description:
								"Refresh secret to revoke. The browser sends the cookie instead. Not both.",
						}),
					),
				},
				{ description: "Session to revoke. The cookie or refreshToken." },
			),
		),
	},
	{
		description: "Revoke the session and clear the refresh cookie.",
	},
);
export type AuthSessionLogoutCommand = Static<
	typeof AuthSessionLogoutCommandSchema
>;

export const AuthAssumeRoleCommandSchema = Type.Object(
	{
		id: idField,
		type: Type.Literal("auth.assumeRole", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				role: Type.Union(
					[
						Type.Literal("user"),
						Type.Literal("account-admin"),
						Type.Literal("super-admin"),
					],
					{ description: "Stored role to open a new session as." },
				),
				accountId: Type.String({
					minLength: 1,
					description: "Account that role is stored on.",
				}),
			},
			{ description: "Hat to assume." },
		),
	},
	{
		grant: "session.assume",
		description:
			"Open a new session as a stored role. Refresh token is a cookie. Same hat on a finished session is role_unchanged.",
	},
);
export type AuthAssumeRoleCommand = Static<typeof AuthAssumeRoleCommandSchema>;

export const AuthSessionLogoutResultSchema = Type.Object(
	{
		revoked: Type.Boolean({
			description: "True when a live session was revoked.",
		}),
	},
	{ description: "Result payload returned by auth.session.logout." },
);
export type AuthSessionLogoutResult = Static<
	typeof AuthSessionLogoutResultSchema
>;

const deviceCodeField = Type.String({
	minLength: 1,
	description:
		"Short device code from the verification URL. This is not the poll secret.",
});

export const AuthLoginDeviceStartCommandSchema = Type.Object(
	{
		id: idField,
		type: Type.Literal("auth.login.device.start", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		description:
			"Start a CLI device login. Returns a code, a verification URL, and a one-time poll secret.",
	},
);
export type AuthLoginDeviceStartCommand = Static<
	typeof AuthLoginDeviceStartCommandSchema
>;

export const AuthLoginDeviceStartResultSchema = Type.Object(
	{
		deviceCode: deviceCodeField,
		verificationUrl: Type.String({
			description: "Page where the person approves this device code.",
		}),
		deviceSecret: Type.String({
			description:
				"Poll secret. Returned once. It is not in the verification URL.",
		}),
		interval: Type.Number({
			description: "Seconds the client waits between polls.",
		}),
		expiresIn: Type.Number({
			description: "Seconds until this grant expires.",
		}),
	},
	{ description: "Result payload returned by auth.login.device.start." },
);
export type AuthLoginDeviceStartResult = Static<
	typeof AuthLoginDeviceStartResultSchema
>;

export const AuthLoginDevicePollCommandSchema = Type.Object(
	{
		id: idField,
		type: Type.Literal("auth.login.device.poll", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				deviceSecret: Type.String({
					minLength: 1,
					description: "Poll secret from auth.login.device.start.",
				}),
			},
			{ description: "Device poll credential." },
		),
	},
	{ description: "Poll a device login. The device code cannot poll." },
);
export type AuthLoginDevicePollCommand = Static<
	typeof AuthLoginDevicePollCommandSchema
>;

export const AuthLoginDevicePollResultSchema = Type.Union(
	[
		Type.Object(
			{
				status: Type.Literal("pending", {
					description: "The person has not approved yet.",
				}),
			},
			{ description: "Device login still waiting." },
		),
		Type.Object(
			{
				status: Type.Literal("approved", {
					description: "The person approved. This poll consumes the grant.",
				}),
				accessToken: Type.String({ description: "CLI session access token." }),
				refreshToken: Type.String({
					description:
						"CLI session refresh secret. Store this, not the access token.",
				}),
				expiresAt: Type.Number({
					description: "Access token expiry, epoch ms.",
				}),
				accountId: Type.String({ description: "Account of the CLI session." }),
				userId: Type.String({ description: "User of the CLI session." }),
				sessionId: Type.Optional(
					Type.String({ description: "CLI session id." }),
				),
			},
			{ description: "Approved CLI session from a device poll." },
		),
	],
	{ description: "Result payload returned by auth.login.device.poll." },
);
export type AuthLoginDevicePollResult = Static<
	typeof AuthLoginDevicePollResultSchema
>;

export const AuthLoginDeviceApproveCommandSchema = Type.Object(
	{
		id: idField,
		type: Type.Literal("auth.login.device.approve", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{ deviceCode: deviceCodeField },
			{ description: "Device code to approve with the signed-in session." },
		),
	},
	{
		description:
			"Approve a device login from a finished user session. Mints the CLI session for the poller and returns no tokens.",
	},
);
export type AuthLoginDeviceApproveCommand = Static<
	typeof AuthLoginDeviceApproveCommandSchema
>;

export const AuthLoginDeviceApproveResultSchema = Type.Object(
	{
		approved: Type.Boolean({
			description: "True when the device grant now holds a CLI session.",
		}),
	},
	{ description: "Result payload returned by auth.login.device.approve." },
);
export type AuthLoginDeviceApproveResult = Static<
	typeof AuthLoginDeviceApproveResultSchema
>;

export const AuthLoginDeviceDenyCommandSchema = Type.Object(
	{
		id: idField,
		type: Type.Literal("auth.login.device.deny", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{ deviceCode: deviceCodeField },
			{ description: "Device code to deny." },
		),
	},
	{
		description:
			"Deny a device login. The next poll is refused. Requires a finished user session.",
	},
);
export type AuthLoginDeviceDenyCommand = Static<
	typeof AuthLoginDeviceDenyCommandSchema
>;

export const AuthLoginDeviceDenyResultSchema = Type.Object(
	{
		denied: Type.Boolean({
			description: "True when a pending device grant was denied.",
		}),
	},
	{ description: "Result payload returned by auth.login.device.deny." },
);
export type AuthLoginDeviceDenyResult = Static<
	typeof AuthLoginDeviceDenyResultSchema
>;
