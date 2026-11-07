# syntax=docker/dockerfile:1
# M5-T5c (YUK-321) — Hono + TanStack Start 前门形态，双进程（gate 选项 b 已裁决）：
# app 容器跑 dist/server.cjs，worker 容器同镜像跑 dist/worker.cjs（compose 层
# command 覆盖），presence 走 PG 表（PgPresenceStore），不设 RW_WORKER。
# Production and the supported runtime contract use Node 24 (YUK-686).
# Pinned: a moving tag re-runs every layer below, including the Chromium one. Dependabot bumps it.
FROM node:24-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS base
ENV PNPM_HOME=/pnpm PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS deps
# Optional download mirror for networks where the default registry crawls. The lockfile
# integrity hashes still decide what gets installed.
ARG NPM_REGISTRY
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; export COREPACK_NPM_REGISTRY="$NPM_REGISTRY"; fi; \
    pnpm install --frozen-lockfile

FROM base AS builder
ARG NPM_REGISTRY
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN if [ -n "$NPM_REGISTRY" ]; then export COREPACK_NPM_REGISTRY="$NPM_REGISTRY"; fi; pnpm build

# Parent of the flat npm stages below; only their node_modules reach the final images.
FROM node:24-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS npmbase
ARG NPM_REGISTRY
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi

# Stage 2.5: install sharp into a clean flat node_modules so it can be
# composed into the runner image without colliding with the curated
# node_modules layout.
# Same reasoning as sharp — pnpm's symlinks won't survive a plain COPY into
# the runner image. Use npm for flat layout.
FROM npmbase AS sharpdeps
WORKDIR /sharp
RUN npm install --omit=dev --no-audit --no-fund sharp@^0.34.5

# Stage 2.6: install the MCP client into its own clean node_modules.
# `build:migrate` marks `@modelcontextprotocol/sdk` external, so the shipped
# dist/migrate.cjs may resolve it at runtime; pnpm's symlinked layout does not
# survive a plain COPY into the runner image — use npm flat layout (same
# reasoning as sharpdeps). The pin MUST match pnpm-lock.yaml's resolution.
FROM npmbase AS mcpdeps
WORKDIR /mcp
RUN npm install --omit=dev --no-audit --no-fund \
    @modelcontextprotocol/sdk@1.29.0

# Stage 2.7: install better-sqlite3 into its own clean flat node_modules.
# YUK-341 — mem0 history (disableHistory:false, src/server/ai/mem0/client.ts) uses
# SQLiteManager → loads the native better_sqlite3.node. esbuild
# --external:better-sqlite3 (build:server + build:worker) keeps the .node out of
# the bundle, so the runner needs it as a flat overlay (like sharp above).
# npm flat layout; prebuild-install fetches the node24 linux prebuild (no compile,
# so the slim image needs no build toolchain — same path sharp relies on).
FROM npmbase AS sqlitedeps
WORKDIR /sqlite
RUN npm install --omit=dev --no-audit --no-fund better-sqlite3@^12.6.2

# Stage 2.8: keep PDFium external to the server CJS bundle and ship its WASM
# beside the package. Bundling its ESM entry rewrites import.meta.url to an
# undefined shim, so the first PDF/DOCX evidence render crashes before loading
# pdfium.wasm. A flat npm install lets Node resolve the package's CJS export,
# whose __dirname-based WASM lookup remains valid in the runner (YUK-636).
FROM npmbase AS pdfiumdeps
WORKDIR /pdfium
RUN npm install --omit=dev --no-audit --no-fund @hyzyla/pdfium@3.0.0

# Stage 2.9 (YUK-1529): playwright-core flat install for the worker-only
# worksheet render job. `build:worker` marks playwright-core external (the job
# module is only loaded by worker registration), so the shipped dist/worker.cjs
# resolves it at runtime; pnpm's symlinked layout does not survive a plain COPY
# — flat npm layout, same reasoning as sharp/mcp/sqlite/pdfium stages. The pin
# MUST match package.json (aligned with devDependency @playwright/test 1.64.0).
FROM npmbase AS pwdeps
WORKDIR /pw
RUN npm install --omit=dev --no-audit --no-fund playwright-core@1.64.0

# Stage 2.10 (YUK-1548): mermaid + jsdom flat install for the worker-only
# compose_block diagram validator (src/kernel/blocks/mermaid-validate.ts).
# `build:worker`/`build:server` mark both packages external, so the shipped
# bundle resolves them from node_modules on first use — keeping them out of
# the bundle also fixes jsdom's `browser/default-stylesheet.css` read, which
# resolved relative to dist/ when inlined and always ENOENT'd. Bundling was
# never an option for jsdom for the same reason as pdfium above. Flat npm
# layout — same reasoning as sharp/mcp/sqlite/pdfium/pw stages; the dep tree
# (~100 packages) shares no top-level name with the curated overlays, so a
# plain node_modules merge cannot clobber them. Pins MUST match package.json.
FROM npmbase AS mermaiddeps
WORKDIR /mermaidjs
RUN npm install --omit=dev --no-audit --no-fund mermaid@12.2.0 jsdom@30.1.3

# Laminar SDK for app and worker. It is ESM that calls createRequire(import.meta.url) at load,
# which is undefined once bundled to CJS, so it stays external. It needs a different `uuid`
# major than the mermaid overlay, so it lives in its own tree and is linked into node_modules;
# a plain merge would mix their files. The pin MUST match package.json.
FROM npmbase AS lmnrdeps
WORKDIR /lmnr
RUN npm install --omit=dev --no-audit --no-fund @lmnr-ai/lmnr@0.8.53

# System layers shared by runner and worker. Nothing here may depend on source code:
# a code-only change has to keep the chromium-os layer below cached.
FROM base AS runtime-os
ENV NODE_ENV=production
# 文档转换链 + sharp 运行库 —— apt 两层逐字沿旧 runner。
RUN apt-get update && apt-get install -y --no-install-recommends \
      libvips42 pandoc libreoffice-core libreoffice-writer fonts-noto-cjk \
    && rm -rf /var/lib/apt/lists/*
# Pre-create the worker's named-volume mountpoint with the
# matching owner; docker-compose's mem0-init also repairs existing root-owned
# volumes during upgrades.
RUN mkdir -p /var/lib/mem0 && chown node:node /var/lib/mem0

FROM runtime-os AS runner
COPY --from=builder /app/dist ./dist
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
COPY --from=lmnrdeps /lmnr/node_modules ./vendor/lmnr/node_modules
RUN ln -s ../vendor/lmnr/node_modules/@lmnr-ai ./node_modules/@lmnr-ai
RUN test -f node_modules/@lmnr-ai/lmnr/package.json
RUN test -s node_modules/@hyzyla/pdfium/dist/pdfium.wasm
ENV API_PORT=8787 RW_FRONTDOOR=1
# gate 选项 b：不设 RW_WORKER（worker 独立进程，compose worker 服务 command 覆盖跑 dist/worker.cjs）。
EXPOSE 8787
USER node
CMD ["node", "dist/server.cjs"]

# Chromium 版本由 playwright-core@1.64.0 的 browsers.json 钉死；只装
# chromium-headless-shell（job 全程无头），不带完整 headed chromium。
# `install --with-deps` 还要 apt 装 Debian 运行库，所以它要在 root 下、代码层之前跑。
FROM runtime-os AS chromium-os
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Build-only download mirror; check a mirrored browser's hash against Playwright's CDN first.
ARG PLAYWRIGHT_DOWNLOAD_HOST
COPY --from=pwdeps /pw/node_modules/playwright-core ./node_modules/playwright-core
RUN node node_modules/playwright-core/cli.js install --with-deps chromium-headless-shell \
    && chmod -R a+rX /ms-playwright

# YUK-1529 — worker 镜像：runner 的内容 + 无头 Chromium（worksheet_render job 的
# playwright-core）。末位 stage 是 worker，所有用本 Dockerfile 的 compose
# 服务必须显式钉 target：app/migrate/mem0-init → runner（镜像不变），只有
# worker 服务 → worker。
FROM base AS workspace-launcher
RUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev \
    && rm -rf /var/lib/apt/lists/*
COPY scripts/workspace/launch.c /tmp/launch.c
RUN gcc -O2 -Wall -Wextra -Werror -o /workspace-launch /tmp/launch.c

FROM chromium-os AS worker
RUN apt-get update && apt-get install -y --no-install-recommends python3 libcap2-bin \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 29082 agent-sandbox \
    && useradd --uid 29082 --gid 29082 --no-create-home --shell /usr/sbin/nologin agent-sandbox \
    && mkdir -p /var/lib/tlp/workspaces \
    && chmod 1733 /var/lib/tlp/workspaces
COPY --from=workspace-launcher /workspace-launch /usr/local/libexec/workspace-launch
RUN chown root:node /usr/local/libexec/workspace-launch \
    && chmod 0750 /usr/local/libexec/workspace-launch \
    && setcap cap_setuid,cap_setgid+ep /usr/local/libexec/workspace-launch
COPY --from=runner /app ./
# YUK-1548 — mermaid + jsdom flat overlay for compose_block diagram validation
# (worker-only; the app image only registers the tool module, never executes
# it, so runner stays free of the ~220MB dep tree).
COPY --from=mermaiddeps /mermaidjs/node_modules ./node_modules
ENV API_PORT=8787 RW_FRONTDOOR=1
EXPOSE 8787
USER node
CMD ["node", "dist/worker.cjs"]
