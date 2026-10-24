/**
 * REST mapping rule for `/api`. Declarations only.
 * The concrete per-command method and path live in the generated route table
 * (`@cadmus/contract/routes`). Server coercion and client query encoding are
 * implementations of `queryEncoding` outside this package.
 */
export const API_PATH_PREFIX = "/api/";

export const REST_MAPPING_RULE = {
	pathPrefix: API_PATH_PREFIX,
	/** `file.read` ↔ `/api/file/read`. One path segment per dot-separated command part. */
	pathPattern: "/api/<group>/<cmd>",
	readOnly: {
		methods: ["GET", "HEAD"],
		payload: "query",
	},
	mutating: {
		methods: ["POST"],
		payload: "json-body",
	},
	queryEncoding: {
		omitUndefined: true,
		string: "raw",
		number: "decimal-text",
		boolean: "true-or-false",
		arrayOfPrimitives: "repeated-keys",
		arrayOfObjects: "json",
		object: "json",
	},
} as const;

/**
 * Query keys consumed by edge family routing. They are not payload fields
 * unless the payload schema lists them. `token` is not reserved: `/api`
 * rejects a `token` query parameter before coercion.
 */
export const REST_RESERVED_QUERY_KEYS = [
	"accountId",
	"userId",
	"familyId",
] as const;

/** HTTP status for a known error code. Codes ending in `_not_found` are 404. */
export const ERROR_HTTP_STATUS = {
	unauthorized: 401,
	query_token_not_allowed: 401,
	header_required: 401,
	forbidden: 403,
	not_found: 404,
	family_not_found: 404,
	cas_conflict: 409,
	conflict: 409,
	command_failed: 500,
} as const;

export const NOT_FOUND_CODE_SUFFIX = "_not_found";

/** Status used when a code is not listed and does not end with `_not_found`. */
export const DEFAULT_ERROR_HTTP_STATUS = 400;
