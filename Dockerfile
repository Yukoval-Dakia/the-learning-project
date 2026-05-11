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

USER nextjs

EXPOSE 3000

ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

CMD ["node", "server.js"]
