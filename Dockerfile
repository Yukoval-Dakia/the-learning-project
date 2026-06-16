# syntax=docker/dockerfile:1
# M5-T5c (YUK-321) — Hono + Vite 形态，双进程（gate 选项 b 已裁决）：
# app 容器跑 dist/server.cjs，worker 容器同镜像跑 dist/worker.cjs（compose 层
# command 覆盖），presence 走 PG 表（PgPresenceStore），不设 RW_WORKER。
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN pnpm rw:web:build && pnpm build:server && pnpm build:worker && pnpm build:migrate

# Stage 2.5: install sharp into a clean flat node_modules so it can be
# composed into the runner image without colliding with the curated
# node_modules layout.
# Same reasoning as sharp — pnpm's symlinks won't survive a plain COPY into
# the runner image. Use npm for flat layout.
FROM node:24-bookworm-slim AS sharpdeps
WORKDIR /sharp
RUN npm install --omit=dev --no-audit --no-fund sharp@^0.34.5

# Stage 2.6: install Claude Agent SDK into its own clean node_modules.
# Same reasoning as sharp — the platform-specific `claude` binary that ships
# via optionalDependencies is loaded lazily by the runner via dynamic spawn.
# Use npm here for the same flat-layout reason sharpdeps does.
#
# YUK-365 (Codex review P2, Finding 3): these pins MUST stay in lockstep with the
# versions pnpm-lock.yaml resolves (package.json pins claude-agent-sdk ^0.3.168 +
# @anthropic-ai/sdk ^0.102.0; the lockfile resolves 0.3.168 / 0.102.0 / 1.29.0).
# The old 0.3.143 / 0.96.0 pins predated Opus 4.8 (claude-opus-4-8) — that CLI may
# reject the model id the subscription-OAuth lane (AI_PROVIDER_OVERRIDE=anthropic-sub)
# requests, so prod would 4xx while dev (0.3.168) works. Bumped to match the
# lockfile so the runner image runs the exact SDK this lane validated. When you bump
# the package.json/lockfile SDK versions, bump these three pins to match.
FROM node:24-bookworm-slim AS sdkdeps
WORKDIR /sdk
RUN npm install --omit=dev --no-audit --no-fund \
    @anthropic-ai/claude-agent-sdk@0.3.168 \
    @anthropic-ai/sdk@0.102.0 \
    @modelcontextprotocol/sdk@1.29.0

# Stage 2.7: install better-sqlite3 into its own clean flat node_modules.
# YUK-341 — mem0 history (disableHistory:false, src/server/memory/client.ts) uses
# SQLiteManager → loads the native better_sqlite3.node. esbuild
# --external:better-sqlite3 (build:server + build:worker) keeps the .node out of
# the bundle, so the runner needs it as a flat overlay (like sharp/sdk above).
# npm flat layout; prebuild-install fetches the node24 linux prebuild (no compile,
# so the slim image needs no build toolchain — same path sharp relies on).
FROM node:24-bookworm-slim AS sqlitedeps
WORKDIR /sqlite
RUN npm install --omit=dev --no-audit --no-fund better-sqlite3@^12.6.2

FROM base AS runner
ENV NODE_ENV=production
# 文档转换链 + sharp 运行库 —— apt 两层逐字沿旧 runner。
RUN apt-get update && apt-get install -y --no-install-recommends \
      libvips42 pandoc libreoffice-core libreoffice-writer fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/drizzle ./drizzle
# quiz-gen Agent Skill assets — the runner (populateIsolatedSkills) reads
# src/subjects/<id>/skills/ at runtime via readdirSync (not imported).
COPY --from=builder /app/src/subjects/math/skills ./src/subjects/math/skills
COPY --from=builder /app/src/subjects/wenyan/skills ./src/subjects/wenyan/skills
COPY --from=builder /app/src/subjects/physics/skills ./src/subjects/physics/skills
# sharp + 原生依赖 4 行（来自 sharpdeps 的 flat node_modules）
COPY --from=sharpdeps /sharp/node_modules/sharp ./node_modules/sharp
COPY --from=sharpdeps /sharp/node_modules/@img ./node_modules/@img
COPY --from=sharpdeps /sharp/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=sharpdeps /sharp/node_modules/semver ./node_modules/semver
# Claude Agent SDK + peers 2 行（namespace 整目录 overlay，来自 sdkdeps）
COPY --from=sdkdeps /sdk/node_modules/@anthropic-ai ./node_modules/@anthropic-ai
COPY --from=sdkdeps /sdk/node_modules/@modelcontextprotocol ./node_modules/@modelcontextprotocol
# better-sqlite3 + 运行时依赖（bindings → file-uri-to-path），来自 sqlitedeps（YUK-341 mem0 history）
COPY --from=sqlitedeps /sqlite/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=sqlitedeps /sqlite/node_modules/bindings ./node_modules/bindings
COPY --from=sqlitedeps /sqlite/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
ENV API_PORT=8787 RW_STATIC_DIR=/app/web/dist
# gate 选项 b：不设 RW_WORKER（worker 独立进程，compose worker 服务 command 覆盖跑 dist/worker.cjs）。
EXPOSE 8787
CMD ["node", "dist/server.cjs"]
