import { type Static, Type } from "typebox";
import { ProtocolErrorSchema } from "./common.js";
import { CredentialSummarySchema } from "./records.js";

/**
 * Interactive input prompt requested by an OAuth flow.
 */
export const OAuthPromptSchema = Type.Object(
	{
		type: Type.Union(
			[
				Type.Literal("text", { description: "Single-line plain text prompt." }),
				Type.Literal("secret", {
					description:
						"Masked confidential input prompt (e.g. password or secret).",
				}),
				Type.Literal("select", {
					description:
						"Selection list prompt requiring the user to choose an option.",
				}),
				Type.Literal("manual_code", {
					description:
						"Manual authorization code entry copied from an external browser window.",
				}),
			],
			{
				description:
					"Input prompt type: 'text', 'secret', 'select', or 'manual_code'.",
			},
		),
		message: Type.String({
			description: "Human-readable prompt instruction displayed to the user.",
		}),
		placeholder: Type.Optional(
			Type.String({
				description: "Optional input placeholder text for client UI display.",
			}),
		),
		options: Type.Optional(
			Type.Array(
				Type.Object(
					{
						id: Type.String({
							description: "Unique value identifier for this option choice.",
						}),
						label: Type.String({
							description: "Human-readable label for this option choice.",
						}),
						description: Type.Optional(
							Type.String({
								description: "Optional secondary description for the option.",
							}),
						),
					},
					{ description: "Selectable option entry." },
				),
				{
					description:
						"Array of selectable choices when prompt type is 'select'.",
				},
			),
		),
	},
	{
		description:
			"Interactive user prompt descriptor requested during an ongoing OAuth authentication flow.",
	},
);
export type OAuthPrompt = Static<typeof OAuthPromptSchema>;

/**
 * Metadata descriptor of an OAuth-capable AI provider and its authorization flow mechanism.
 */
export const OAuthProviderInfoSchema = Type.Object(
	{
		providerId: Type.String({
			description:
				"Unique identifier of the AI provider (e.g. 'anthropic', 'openai', 'github').",
		}),
		name: Type.String({
			description: "Human-readable display name of the provider.",
		}),
		flowType: Type.Union(
			[
				Type.Literal("device_code", {
					description:
						"RFC 8628 OAuth 2.0 Device Authorization Grant (user navigates to URL and enters code).",
				}),
				Type.Literal("browser_code", {
					description:
						"Browser redirection flow with authorization code exchange.",
				}),
				Type.Literal("interactive", {
					description:
						"Multi-step interactive CLI prompt flow driven by server-sent prompts.",
				}),
			],
			{
				description:
					"OAuth flow mechanism supported: 'device_code', 'browser_code', or 'interactive'.",
			},
		),
		loginLabel: Type.Optional(
			Type.String({
				description:
					"Optional button or action label for starting authentication (e.g. 'Log in with Claude Pro/Max').",
			}),
		),
		isSubscription: Type.Optional(
			Type.Boolean({
				description:
					"True if authentication links an active model subscription rather than token billing.",
			}),
		),
	},
	{
		description:
			"Provider capability descriptor detailing supported OAuth authorization flows.",
	},
);
export type OAuthProviderInfo = Static<typeof OAuthProviderInfoSchema>;

/**
 * Lifecycle record and status of an active or finalized OAuth authorization flow.
 */
export const OAuthFlowRecordSchema = Type.Object(
	{
		flowId: Type.String({
			description: "Unique identifier for this OAuth flow session.",
		}),
		providerId: Type.String({
			description: "Identifier of the provider being authenticated.",
		}),
		flowType: Type.Union(
			[
				Type.Literal("device_code"),
				Type.Literal("browser_code"),
				Type.Literal("interactive"),
			],
			{ description: "OAuth flow type used." },
		),
		status: Type.Union(
			[
				Type.Literal("pending", {
					description:
						"Flow is waiting for the user to navigate to verification URL.",
				}),
				Type.Literal("prompt", {
					description:
						"Flow is awaiting interactive user input described by the prompt field.",
				}),
				Type.Literal("progress", {
					description:
						"Authorization is actively polling or exchanging credentials.",
				}),
				Type.Literal("completed", {
					description:
						"Authentication completed successfully; credentials have been saved.",
				}),
				Type.Literal("failed", {
					description: "Authentication encountered an error and terminated.",
				}),
				Type.Literal("cancelled", {
					description: "Authentication was explicitly cancelled by the client.",
				}),
			],
			{ description: "Current lifecycle state of the OAuth flow." },
		),
		userCode: Type.Optional(
			Type.String({
				description:
					"User verification code to display for device authorization flows.",
			}),
		),
		verificationUri: Type.Optional(
			Type.String({
				description:
					"Target URL where the user must navigate to approve the authorization.",
			}),
		),
		verificationUriComplete: Type.Optional(
			Type.String({
				description:
					"Pre-authenticated URL that automatically embeds the userCode for one-click approval.",
			}),
		),
		authorizationUrl: Type.Optional(
			Type.String({
				description:
					"Browser authorization URL used in browser-based redirect flows.",
			}),
		),
		intervalSeconds: Type.Optional(
			Type.Number({
				description:
					"Recommended polling interval in seconds for device code status checking.",
			}),
		),
		expiresAt: Type.Optional(
			Type.Number({
				description:
					"Epoch timestamp in milliseconds when this authorization flow will expire.",
			}),
		),
		prompt: Type.Optional(OAuthPromptSchema),
		message: Type.Optional(
			Type.String({
				description:
					"Human-readable status or guidance message intended for display.",
			}),
		),
		credential: Type.Optional(CredentialSummarySchema),
		error: Type.Optional(ProtocolErrorSchema),
		updatedAt: Type.Number({
			description:
				"Epoch timestamp in milliseconds when this flow record was last updated.",
		}),
	},
	{
		description:
			"Full state and progression metadata for an ongoing or finalized OAuth authentication flow.",
	},
);
export type OAuthFlowRecord = Static<typeof OAuthFlowRecordSchema>;

/**
 * Command to query available OAuth providers and their supported flow types.
 */
export const AccountOAuthProvidersCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.oauth.providers", {
			description: "Command type identifier.",
		}),
		payload: Type.Optional(
			Type.Object({}, { description: "Empty parameter payload." }),
		),
	},
	{
		readOnly: true,
		description:
			"Command to list all supported OAuth providers and their authorization requirements.",
	},
);
export type AccountOAuthProvidersCommand = Static<
	typeof AccountOAuthProvidersCommandSchema
>;

/**
 * Command to initiate a new OAuth flow for an AI provider.
 */
export const AccountOAuthStartCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.oauth.start", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				providerId: Type.String({
					minLength: 1,
					description:
						"Provider identifier to authenticate (e.g. 'anthropic', 'openai').",
				}),
				redirectUri: Type.Optional(
					Type.String({
						description:
							"Optional callback URL for redirect-based browser OAuth flows.",
					}),
				),
			},
			{ description: "Parameters for starting the OAuth flow." },
		),
	},
	{
		description:
			"Command to begin an OAuth authentication process for a provider, returning verification URLs and flowId.",
	},
);
export type AccountOAuthStartCommand = Static<
	typeof AccountOAuthStartCommandSchema
>;

/**
 * Command to poll or check status of an active OAuth flow.
 */
export const AccountOAuthStatusCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.oauth.status", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				flowId: Type.String({
					minLength: 1,
					description:
						"Unique flow identifier returned by account.oauth.start.",
				}),
			},
			{ description: "Parameters identifying the active OAuth flow." },
		),
	},
	{
		readOnly: true,
		description:
			"Command to query the current progress, prompt, or completion status of an active OAuth flow.",
	},
);
export type AccountOAuthStatusCommand = Static<
	typeof AccountOAuthStatusCommandSchema
>;

/**
 * Command to submit user response or authorization code to advance an active OAuth flow.
 */
export const AccountOAuthSubmitCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.oauth.submit", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				flowId: Type.String({
					minLength: 1,
					description:
						"Unique flow identifier returned by account.oauth.start.",
				}),
				input: Type.String({
					minLength: 1,
					description:
						"User-provided input string, such as a copied authorization code or selected choice ID.",
				}),
			},
			{
				description:
					"Parameters containing the user response for the active flow.",
			},
		),
	},
	{
		description:
			"Command to advance an interactive or code-submission OAuth step with user-supplied input.",
	},
);
export type AccountOAuthSubmitCommand = Static<
	typeof AccountOAuthSubmitCommandSchema
>;

/**
 * Command to abort and cancel an in-progress OAuth flow.
 */
export const AccountOAuthCancelCommandSchema = Type.Object(
	{
		id: Type.String({
			minLength: 1,
			description:
				"Non-empty unique correlation identifier for this command request.",
		}),
		type: Type.Literal("account.oauth.cancel", {
			description: "Command type identifier.",
		}),
		payload: Type.Object(
			{
				flowId: Type.String({
					minLength: 1,
					description: "Unique flow identifier to cancel.",
				}),
			},
			{ description: "Parameters identifying the OAuth flow to cancel." },
		),
	},
	{
		description:
			"Command to immediately abort an active OAuth flow and release pending resources.",
	},
);
export type AccountOAuthCancelCommand = Static<
	typeof AccountOAuthCancelCommandSchema
>;

/**
 * Result returned by account.oauth.providers containing the list of supported providers.
 */
export const AccountOAuthProvidersResultSchema = Type.Object(
	{
		providers: Type.Array(OAuthProviderInfoSchema, {
			description:
				"List of supported OAuth providers and their flow mechanisms.",
		}),
	},
	{
		description:
			"Result payload returned by account.oauth.providers containing available OAuth providers.",
	},
);
export type AccountOAuthProvidersResult = Static<
	typeof AccountOAuthProvidersResultSchema
>;

/**
 * Result returned by account.oauth.start containing the initial flow state.
 */
export const AccountOAuthStartResultSchema = Type.Object(
	{
		flow: OAuthFlowRecordSchema,
	},
	{
		description:
			"Result payload returned by account.oauth.start containing initial flow state and verification URLs.",
	},
);
export type AccountOAuthStartResult = Static<
	typeof AccountOAuthStartResultSchema
>;

/**
 * Result returned by account.oauth.status containing updated flow progress.
 */
export const AccountOAuthStatusResultSchema = Type.Object(
	{
		flow: OAuthFlowRecordSchema,
	},
	{
		description:
			"Result payload returned by account.oauth.status with current flow status.",
	},
);
export type AccountOAuthStatusResult = Static<
	typeof AccountOAuthStatusResultSchema
>;

/**
 * Result returned by account.oauth.submit containing updated flow progress.
 */
export const AccountOAuthSubmitResultSchema = Type.Object(
	{
		flow: OAuthFlowRecordSchema,
	},
	{
		description:
			"Result payload returned by account.oauth.submit after processing user input.",
	},
);
export type AccountOAuthSubmitResult = Static<
	typeof AccountOAuthSubmitResultSchema
>;

/**
 * Result returned by account.oauth.cancel confirming cancellation.
 */
export const AccountOAuthCancelResultSchema = Type.Object(
	{
		flow: OAuthFlowRecordSchema,
		cancelled: Type.Boolean({
			description: "True if the flow was cancelled.",
		}),
	},
	{
		description:
			"Result payload returned by account.oauth.cancel confirming cancellation of the flow.",
	},
);
export type AccountOAuthCancelResult = Static<
	typeof AccountOAuthCancelResultSchema
>;
