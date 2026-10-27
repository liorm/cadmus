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
COPY packages/contract/package.json ./packages/contract/
COPY packages/daemon/package.json ./packages/daemon/
COPY packages/tui/package.json ./packages/tui/
COPY packages/web/package.json ./packages/web/
COPY packages/worker/package.json ./packages/worker/
RUN bun install --frozen-lockfile

# ==========================================
# Stage 3: Build Web UI
# ==========================================
FROM oven/bun:1-slim AS web-builder

WORKDIR /app

COPY tsconfig.json package.json bun.lock ./
COPY packages/contract/ ./packages/contract/
COPY packages/web/ ./packages/web/

COPY --from=deps /app/node_modules ./node_modules

RUN bun run web:build

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

# Copy configuration, source files, and packages
COPY tsconfig.json wrangler.jsonc biome.json package.json bun.lock ./
COPY packages/worker/ ./packages/worker/
COPY packages/contract/ ./packages/contract/
COPY packages/tui/ ./packages/tui/
COPY packages/daemon/ ./packages/daemon/

# Copy built Web UI assets from Stage 3
COPY --from=web-builder /app/packages/web/dist ./packages/web/dist

# Copy installed node_modules from Stage 2
COPY --from=deps /app/node_modules ./node_modules

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
