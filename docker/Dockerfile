# ==========================================
# Stage 1: Download official celld binary
# ==========================================
FROM debian:bookworm-slim AS celld-bin

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV CELLD_INSTALL_ROOT=/usr/local
RUN curl -fsSL https://celld.dev/install.sh | sh

# ==========================================
# Stage 2: Install dependencies
# ==========================================
FROM oven/bun:1-slim AS deps

WORKDIR /app

COPY package.json bun.lock ./
COPY tui/package.json tui/bun.lock ./tui/
COPY web/package.json web/bun.lock ./web/
RUN bun install --frozen-lockfile \
 && bun install --frozen-lockfile --cwd tui \
 && bun install --frozen-lockfile --cwd web

# ==========================================
# Stage 3: Build Web UI
# ==========================================
FROM oven/bun:1-slim AS web-builder

WORKDIR /app

COPY tsconfig.json package.json bun.lock ./
COPY src/ ./src/
COPY web/ ./web/

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/web/node_modules ./web/node_modules

RUN bun run --cwd web build

# ==========================================
# Stage 4: Lean runtime image
# ==========================================
FROM oven/bun:1-slim AS runner

# Ensure CA certificates are present for outbound HTTPS to LLM APIs
RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy celld binary from Stage 1
COPY --from=celld-bin /usr/local/bin/celld /usr/local/bin/celld

# Copy configuration, source files, and TUI package
COPY tsconfig.json wrangler.jsonc biome.json package.json bun.lock ./
COPY src/ ./src/
COPY tui/ ./tui/

# Copy built Web UI assets from Stage 3
COPY --from=web-builder /app/web/dist ./web/dist

# Copy installed node_modules from Stage 2
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/tui/node_modules ./tui/node_modules

# Ensure esbuild from node_modules is available on PATH for celld
ENV PATH="/app/node_modules/.bin:${PATH}"

# Prepare storage directory and entrypoint
RUN mkdir -p /data /app/.celld

COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Expose HTTP and WebSocket listener port
EXPOSE 8787

# Persistent volume for DO SQLite and D1 state
VOLUME ["/data"]

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
