# YUK-137 [M2]: node:24-bookworm-slim keeps a floating *patch* tag on purpose.
# The major (24) is pinned and matches the project runtime; pinning a full
# patch tag here is brittle (slim patch tags are GC'd / can vanish, breaking the
# build) for only a Low-severity benefit. The audit's High-severity unpinned
# items were the docker-compose images (pgvector, cloudflared) — those are now
# pinned. Revisit if we move to digest-pinned base images across the board.
# Stage 1: Install dependencies
FROM node:24-bookworm-slim AS deps
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY package.json pnpm-lock.yaml ./
# Copy .npmrc if it exists (optional)
RUN pnpm install --frozen-lockfile

# Stage 2: Build the application
FROM node:24-bookworm-slim AS builder
WORKDIR /app

RUN corepack enable && corepack prepare pnpm@9.12.0 --activate

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build Next.js standalone output.
# DATABASE_URL must be provided at runtime; supply a dummy value here so
# the db/client module-level guard doesn't abort the build when collecting
# page data (Next.js never actually connects at build time).
RUN DATABASE_URL=postgres://build:build@localhost:5432/build pnpm build

# Bundle pg-boss worker entrypoint into a single CJS file co-located with
# the Next standalone server. The same image runs as either:
#   CMD ["node", "server.js"]   → web/app process
#   CMD ["node", "worker.cjs"]  → pg-boss worker process (crons + handlers)
#   CMD ["node", "migrate.cjs"] → drizzle migration runner (YUK-65 init container)
RUN pnpm build:worker
RUN pnpm build:migrate

# Stage 2.5: install sharp into a clean flat node_modules so it can be
# composed into the runner image without colliding with the Next standalone
# layout (whose node_modules is curated by the tracer).
FROM node:24-bookworm-slim AS sharpdeps
WORKDIR /sharp
RUN npm install --omit=dev --no-audit --no-fund sharp@^0.34.5

# Stage 2.6: install Claude Agent SDK into its own clean node_modules.
# Same reasoning as sharp — Next's tracer can't see the platform-specific
# `claude` binary that ships via optionalDependencies (only the right
# linux-{arch} sub-package is installed at deps-resolution time), and the
# SDK is loaded lazily by the runner via dynamic spawn so the tracer
# doesn't follow it. Use npm here for the same flat-layout reason sharpdeps
# does; pnpm's symlinks won't survive a plain COPY into the runner image.
FROM node:24-bookworm-slim AS sdkdeps
WORKDIR /sdk
RUN npm install --omit=dev --no-audit --no-fund \
    @anthropic-ai/claude-agent-sdk@0.3.143 \
    @anthropic-ai/sdk@0.96.0 \
    @modelcontextprotocol/sdk@1.29.0

# Stage 3: Production runner
FROM node:24-bookworm-slim AS runner
WORKDIR /app

ENV NODE_ENV=production

# libvips is needed by `sharp` (image cropping in Sub 0c ingestion pipeline).
# Pinning via the bookworm package keeps us off compiling from source.
RUN apt-get update && apt-get install -y --no-install-recommends libvips && \
    rm -rf /var/lib/apt/lists/*

# Create non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy only what's needed for standalone
COPY --from=builder --chown=nextjs:nodejs /app/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/.next/static ./.next/static
COPY --from=builder --chown=nextjs:nodejs /app/public ./public

# `pnpm build:worker` writes worker.cjs into .next/standalone/ which is copied
# above; .cjs because package.json sets "type": "module" but the esbuild bundle
# emits CommonJS. This line is purely a no-op assert so the file is present.
RUN test -f ./worker.cjs || (echo "worker.cjs missing — check pnpm build:worker output" && exit 1)
RUN test -f ./migrate.cjs || (echo "migrate.cjs missing — check pnpm build:migrate output" && exit 1)

# YUK-65: drizzle migrations bundle. The `migrate` compose service (init
# container) reads SQL files from this folder via drizzle-orm/postgres-js
# migrator at runtime. Copying here keeps the runner image self-contained.
COPY --from=builder --chown=nextjs:nodejs /app/drizzle ./drizzle

# sharp is a native module used by the tencent_ocr_extract handler in the
# worker process and by /api/assets/* in the app process. Next standalone
# tracer only includes what route code imports — worker handlers aren't traced
# — and pnpm's symlinked layout doesn't survive a plain COPY. The dedicated
# `sharpdeps` stage installs sharp via npm into a clean flat node_modules; we
# overlay it here so the runner's node_modules is the standalone curated set
# PLUS sharp + its @img/* native deps.
COPY --from=sharpdeps --chown=nextjs:nodejs /sharp/node_modules/sharp ./node_modules/sharp
COPY --from=sharpdeps --chown=nextjs:nodejs /sharp/node_modules/@img ./node_modules/@img
COPY --from=sharpdeps --chown=nextjs:nodejs /sharp/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=sharpdeps --chown=nextjs:nodejs /sharp/node_modules/semver ./node_modules/semver

# Claude Agent SDK + its peer @anthropic-ai/sdk + @modelcontextprotocol/sdk.
# The flat npm layout from `sdkdeps` includes the platform-correct
# claude-agent-sdk-linux-{x64|arm64}/ sub-package; copying the whole @anthropic-ai
# namespace picks it up.
COPY --from=sdkdeps --chown=nextjs:nodejs /sdk/node_modules/@anthropic-ai ./node_modules/@anthropic-ai
COPY --from=sdkdeps --chown=nextjs:nodejs /sdk/node_modules/@modelcontextprotocol ./node_modules/@modelcontextprotocol

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
