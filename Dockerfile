# syntax=docker/dockerfile:1
# M5-T5c (YUK-321) — Hono + Vite 形态，双进程（gate 选项 b 已裁决）：
# app 容器跑 dist/server.cjs，worker 容器同镜像跑 dist/worker.cjs（compose 层
# command 覆盖），presence 走 PG 表（PgPresenceStore），不设 RW_WORKER。
# Production and the supported runtime contract use Node 24 (YUK-686).
FROM node:24-slim AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
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

# Stage 2.6: install the MCP client into its own clean node_modules.
# `build:migrate` marks `@modelcontextprotocol/sdk` external, so the shipped
# dist/migrate.cjs may resolve it at runtime; pnpm's symlinked layout does not
# survive a plain COPY into the runner image — use npm flat layout (same
# reasoning as sharpdeps). The pin MUST match pnpm-lock.yaml's resolution.
FROM node:24-bookworm-slim AS mcpdeps
WORKDIR /mcp
RUN npm install --omit=dev --no-audit --no-fund \
    @modelcontextprotocol/sdk@1.29.0

# Stage 2.7: install better-sqlite3 into its own clean flat node_modules.
# YUK-341 — mem0 history (disableHistory:false, src/server/memory/client.ts) uses
# SQLiteManager → loads the native better_sqlite3.node. esbuild
# --external:better-sqlite3 (build:server + build:worker) keeps the .node out of
# the bundle, so the runner needs it as a flat overlay (like sharp above).
# npm flat layout; prebuild-install fetches the node24 linux prebuild (no compile,
# so the slim image needs no build toolchain — same path sharp relies on).
FROM node:24-bookworm-slim AS sqlitedeps
WORKDIR /sqlite
RUN npm install --omit=dev --no-audit --no-fund better-sqlite3@^12.6.2

# Stage 2.8: keep PDFium external to the server CJS bundle and ship its WASM
# beside the package. Bundling its ESM entry rewrites import.meta.url to an
# undefined shim, so the first PDF/DOCX evidence render crashes before loading
# pdfium.wasm. A flat npm install lets Node resolve the package's CJS export,
# whose __dirname-based WASM lookup remains valid in the runner (YUK-636).
FROM node:24-bookworm-slim AS pdfiumdeps
WORKDIR /pdfium
RUN npm install --omit=dev --no-audit --no-fund @hyzyla/pdfium@2.1.13

FROM base AS runner
ENV NODE_ENV=production
# 文档转换链 + sharp 运行库 —— apt 两层逐字沿旧 runner。
RUN apt-get update && apt-get install -y --no-install-recommends \
      libvips42 pandoc libreoffice-core libreoffice-writer fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/web/dist ./web/dist
COPY --from=builder /app/drizzle ./drizzle
# Agent Skill assets — the pi skill-doc resolvers read
# src/subjects/<id>/skills/ at runtime via readFile/readdirSync (not imported),
# so a missing COPY is a silent prod degradation (resolver falls back to prose).
# Coverage is asserted by src/subjects/skills-image-coverage.test.ts (YUK-610).
COPY --from=builder /app/src/subjects/math/skills ./src/subjects/math/skills
COPY --from=builder /app/src/subjects/yuwen/skills ./src/subjects/yuwen/skills
COPY --from=builder /app/src/subjects/physics/skills ./src/subjects/physics/skills
COPY --from=builder /app/src/subjects/_shared/skills ./src/subjects/_shared/skills
# sharp + 原生依赖 4 行（来自 sharpdeps 的 flat node_modules）
COPY --from=sharpdeps /sharp/node_modules/sharp ./node_modules/sharp
COPY --from=sharpdeps /sharp/node_modules/@img ./node_modules/@img
COPY --from=sharpdeps /sharp/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=sharpdeps /sharp/node_modules/semver ./node_modules/semver
# MCP client（namespace 整目录 overlay，来自 mcpdeps — build:migrate 的 external）
COPY --from=mcpdeps /mcp/node_modules/@modelcontextprotocol ./node_modules/@modelcontextprotocol
# better-sqlite3 + 运行时依赖（bindings → file-uri-to-path），来自 sqlitedeps（YUK-341 mem0 history）
COPY --from=sqlitedeps /sqlite/node_modules/better-sqlite3 ./node_modules/better-sqlite3
COPY --from=sqlitedeps /sqlite/node_modules/bindings ./node_modules/bindings
COPY --from=sqlitedeps /sqlite/node_modules/file-uri-to-path ./node_modules/file-uri-to-path
# PDFium JS + sibling pdfium.wasm, from the flat external-package stage (YUK-636)
COPY --from=pdfiumdeps /pdfium/node_modules/@hyzyla/pdfium ./node_modules/@hyzyla/pdfium
RUN test -s node_modules/@hyzyla/pdfium/dist/pdfium.wasm
# Pre-create the worker's named-volume mountpoint with the
# matching owner; docker-compose's mem0-init also repairs existing root-owned
# volumes during upgrades.
RUN mkdir -p /var/lib/mem0 && chown node:node /var/lib/mem0
ENV API_PORT=8787 RW_STATIC_DIR=/app/web/dist
# gate 选项 b：不设 RW_WORKER（worker 独立进程，compose worker 服务 command 覆盖跑 dist/worker.cjs）。
EXPOSE 8787
USER node
CMD ["node", "dist/server.cjs"]
