#!/bin/sh
set -eu

# Ensure /data exists and link persistent storage to .celld/dev
mkdir -p /data/dev
mkdir -p /app/.celld
ln -sfn /data/dev /app/.celld/dev

# Generate / update .dev.vars from environment variables
# celld dev reads .dev.vars in dotenv format to supply/override worker variables
VARS_FILE="/app/.dev.vars"
rm -f "$VARS_FILE"
touch "$VARS_FILE"

append_var() {
	var_name="$1"
	default_val="${2:-}"
	eval "val=\${$var_name:-}"
	if [ -n "$val" ]; then
		echo "$var_name=\"$val\"" >> "$VARS_FILE"
	elif [ -n "$default_val" ]; then
		echo "$var_name=\"$default_val\"" >> "$VARS_FILE"
	fi
}

append_var "CADMUS_ENCRYPTION_KEY" "dev-cadmus-encryption-key-32bytes!"
append_var "CADMUS_DEFAULT_TIMEZONE" "UTC"
append_var "CADMUS_HARVEST_DELAY_MS" "60000"
append_var "CADMUS_LOG_LEVEL" "debug"
append_var "ANTHROPIC_API_KEY"
append_var "OPENAI_API_KEY"
append_var "OPENROUTER_API_KEY"
append_var "XAI_API_KEY"

# Forward any extra CADMUS_* or custom *_API_KEY variables from environment
env | grep -E '^(CADMUS_|.*_API_KEY=)' | while IFS='=' read -r key val; do
	case "$key" in
		CADMUS_ENCRYPTION_KEY|CADMUS_DEFAULT_TIMEZONE|CADMUS_HARVEST_DELAY_MS|CADMUS_LOG_LEVEL|ANTHROPIC_API_KEY|OPENAI_API_KEY|OPENROUTER_API_KEY|XAI_API_KEY)
			# already handled
			;;
		*)
			echo "$key=\"$val\"" >> "$VARS_FILE"
			;;
	esac
done

PORT="${PORT:-8787}"
HOST="${HOST:-0.0.0.0}"

echo "Starting Cadmus All-In-One with celld on ${HOST}:${PORT}..."
exec celld dev /app/wrangler.jsonc --host "$HOST" --port "$PORT" --no-watch --logs "$@"
