# YUK-1352 TanStack Start 前门交付与回退说明

本 lane 基于 `a6d89037b56f5b0c690137a1354186e0ea07e216`，唯一 writer 工作树为
`/Volumes/YukovalSBak/yukoval-projects/tlp-yuk1352-start-frontdoor`。owner 最新指示覆盖准备计划
原先的 UI 同交付和等待排期。此交付只有源码、隔离 TEST listener 和本地检查；没有部署、
主 runtime、生产/真实数据、付费模型调用、push、PR、watch 或 merge。P0 最终 gate 由父核验。

## 实现与业务边界

- exact dependencies 为 `@tanstack/react-start@1.168.60`、`@tanstack/react-router@1.170.41`；
  pnpm lock 固定完整图。采用官方 Vite plugin 和 fetch entry，保持单个 Node Web listener。
- `server/index.ts` 保留原 hydration、tool registration/recovery、config 注入和 shutdown owner。
  配置 `RW_STATIC_DIR` 后，把 HTTP fetch 交给 Start。API-only 开发入口仍为原 Hono。
- `server/start/routes/api.$.ts` 用原始 `Request` 调 `context.api.fetch`，原 Hono 组合根、
  capability manifest、token、epoch、响应错误和 stream 保留。没有复制领域规则或业务编排。
- Start request middleware 在 RPC 解析/执行前通过 Hono `/api/auth/check` 验证 token 与 epoch；
  global function middleware 对服务端内部调用也使用同一检查。缺 token/secret 拒绝 401，
  已认证但 fenced 拒绝 503。没有注入服务端 secret 代替调用方凭据。
  现役 Hono 的 `/api/ready` token 豁免也保留；票面旧“health 唯一豁免”与源码有差异，
  本次遵守 owner 的现有 API 行为保留授权，不擅自改变 readiness 契约。
- 没有为了测试而新增无 consumer 的生产 server function，也没有第二个通用业务桥接函数。
  RPC 当前没有生产业务 function；真实业务迁入时仍需 operation 输入验证及权限/事务验收。
- `server/start/routes/$.ts` 原样返回旧 `web/dist` 文档及 assets；未改原 SPA 页面、导航、
  TokenGate 或确定性行为。缺失 chunk 返回 404，避免 HTML 伪装成 JS。
  `/_build/*` 单独提供 Start assets，保留 future migrated route 所需的框架资产路径。
- 原 SPA 和 Start 的路由注册分属两个 TS program，`pnpm typecheck` 同时检查两者；
  生成树按上游约定排除 Biome，手写 routes 正常检查。
- Postgres 仍是业务真相源；没有新增状态存储、调度或恢复机制。worker、memory 不改。
  YUK-1356 的 operation/submit/due-list/Pi tool 和 YUK-1355 的 dispatch type/recovery 均未触及。

最小接入契约：`server/start/context.ts` 的 `FrontdoorContext.api: Hono`，catch-all 传入原
`Request` 并返回原 `Response`。本 lane 不导入 `CreateAttemptBody`、`review-operation` 或
`dispatchNativeAttempt` type，避免占用另一 lane 的业务/恢复 ownership。

## 本地证据及其限制

[机器证据](evidence/2026-10-07-yuk1352-start-frontdoor.json)记录 source file hashes、每条检查
日志 digest 和真实 HTTP listener 的结果。日志保留在本树 `.cache/yuk1352/`。

- 7 scoped unit files / 51 tests passed，包括 7 条 token/epoch 鉴权和 5 条 SPA 回落检查，
  以及原 Hono、boot/shutdown、TokenGate 和 surface inventory 回归。
- `pnpm typecheck`、`pnpm lint`、`pnpm lint:ratchet`、`pnpm build` 通过。
  lint 为既有 297 warnings，0 errors；ratchet 未放宽。build 的旧大 bundle warning 保留。
- capability boundaries、API contracts、architecture deepening、API client usage、provider lanes、
  provider-attempt truth、partition audits 通过。partition 报告保留既有 taint 提示。
- `pnpm gen:postman` 生成后无差异。独立 `127.0.0.1:18952` 在 built Start 下验证
  92 个 Postman 请求未授权 401、28 个现有页面路径返回原 SPA 文档、5 个方法的长嵌套 body/
  params/query 透传、health/auth/OpenAPI/未知 API、HEAD/非页面 POST、SPA/Start 静态路径，
  SSE 首包在流结束前到达，global RPC token/epoch 拒绝分别为 401/503。
- 最终 build 显式使用 4 个非秘密 canary，覆盖 OpenAI/Anthropic/R2/internal token。
  95 个两端客户端产物均不含这些 canary；产物 digest 见机器证据。
- T3 preview 实际访问 `/today`、`/practice`、`/admin/config`，原令牌门呈现；
  输入错误测试令牌后原中文错误提示与 `/api/auth/check` 401 均可见。
  现有 CSS 的 Google Fonts import 被既有 CSP 阻止，未改视觉/安全策略。

这些是传输、鉴权和 SPA 加载证据。epoch 是受控 seam，未访问业务 DB，未登录触发真实
领域 handler；不能称完整已认证学习流程、DB 恢复、Node24 容器或实际镜像发布通过。
本机执行 Node 26.10.0 / pnpm 11.13.1，Node24 image drill 留父线程验收。
没有运行完整 `pnpm test`；DB/schema 无变更，因此本 lane 未增跑 scoped DB/migration gate。

复验只需本树构建产物，禁止把该测试脚本替换为主 runtime 入口：

```bash
pnpm vitest run --config vitest.unit.config.ts server/start/auth.unit.test.ts server/frontdoor.unit.test.ts server/app.unit.test.ts server/index.unit.test.ts server/shutdown.unit.test.ts web/src/TokenGate.unit.test.tsx web/src/surface-inventory.unit.test.ts
pnpm typecheck
pnpm lint
CODEX_FULL_GATE=1 pnpm build
pnpm acceptance:start-frontdoor
```

`pnpm acceptance:start-frontdoor --serve` 可保留仅 loopback 的 TEST listener 供浏览器复核；
script 不 loadEnv、不连数据库、不启 worker、不调用模型。验收完成关闭它。

## 镜像切换/回退 runbook（本 lane 未执行）

父线程完成独立 review、exact-head CI、Node24 测试镜像和隔离恢复副本上的真实业务验收后，
才可按 owner 后续运行授权执行发布。主环境当前 Agent TEST ONLY；此文档不授予日用/生产操作。

1. 记录旧 app 与 worker immutable image digest、Compose project/config、release manifest，
   保留旧镜像。构建/测试新镜像，确认含 `web/dist`、`dist/start/server/server.js` 及 assets、
   三个 CJS entry；独立端口重复 API、token、stream 和页面验收。
2. 本 P1 无 schema 变化、无 worker 任务迁移。按既有 release lock/备份与恢复演练规则执行
   app 切换；app `RW_STATIC_DIR=/app/web/dist`、`API_PORT=8787` 仍相同；worker digest 保持
   当前已验证版本，不能因为镜像同时包含 worker 就无意换其运行版本。
3. 在 private Compose 的精确 project/config 上只替换 `app` 为新 immutable digest，
   使用 `up -d --no-deps app`，不执行 `down`、`--remove-orphans` 或 volume 删除。
   复核 health、ready、无 token 401、有 token 行为、stream 和页面。
4. 出现回退条件时，把 `app` 镜像恢复为记录的旧 immutable digest，再只 recreate app；
   不改数据库、不重投任务、不改 worker。刷新浏览器清理旧 chunk 引用并复验原 API/SPA。
   本阶段兼容回退不需要恢复 DB；后续 lane 的 schema/任务变更必须按其独立回退合同裁决。
5. 更新实际 release manifest 与证据，不以本地 build 替代部署事实。

## P7 清理 owner 和退出条件

清理归 YUK-1359 / P7，旧 SPA fallback 不是永久前门方案。所有 `UI_SURFACES` 页面及其
确定性行为迁入 Start、各页真实验收通过并完成计划规定的无 P0/P1 观察期后，删除
`routes/$.ts`、`buildLegacySpa`、`FrontdoorContext.legacySpa`、旧 SPA main/build 输出和
Vite 开发回落及对应配置；统一 TS router registry，并关闭相应兼容测试。
Hono 去留仍需按 P7 实际 consumer/业务验收作 ADR，不先复制业务规则来删除 Hono。

Linear capture：清理义务已有 YUK-1359，不重复开票；既有字体/CSP现象留 UI 迁移 owner
统一处理。本 lane 未发现新增领域 actionable defect。父线程仍需独立 review、最终 CI、
隔离业务及 image drill，YUK-1352 不设 Done，也不宣称 P0 最终 merge 或全迁移完成。

上游 primary references：
[Start build](https://tanstack.com/start/latest/docs/framework/react/build-from-scratch)、
[fetch entry](https://tanstack.com/start/latest/docs/framework/react/guide/server-entry-point)、
[server routes](https://tanstack.com/start/latest/docs/framework/react/guide/server-routes)、
[middleware](https://tanstack.com/start/latest/docs/framework/react/guide/middleware)。

## PR1592 normal-main integration（2026-10-07，本次最新交接）

以上是初次 lane 交付的历史记录，证据与限制保留。本次 parent 指定唯一 writer 在同一工作树
从 clean `5deb26ccaca70dd6dd5d6dc1a2b5a3735cefab99` 正常执行
`git merge --no-commit --no-ff origin/main`，第二 parent 固定为
`42987dfd7d456ca187e716509d11ea100e7353b9`。没有 rebase、force 或 push。
P0 PR1590 已 squash merged 到该 main。PR1592 已由父线程确认初次独立 review
NONE P0/P1、旧 head checks pass；新 merge head exact CI 尚未运行，待父线程 push 后核验。
本次不启动新 review，不改变原审查预算，不置 YUK-1352 Done。

### 冲突裁决与真实源码比较

实际冲突只有 `PLAN.md`、`.remember/now.md` 和 `pnpm-lock.yaml`。
前两项以 owner 最新事实重写当前状态；保留下方历史 handoff。
lock 选择已验证的 Start 分支版本，保留 exact Start 1.168.60 / Router 1.170.41、
seroval-plugins 1.6.8、Start 的 rou3 及已有 optional-peer snapshot 标识，未重新解析依赖。
`package.json` 自动合并后与 first parent 原字节相同。

`git rev-parse a6d89037^{tree} origin/main^{tree}` 两次均为
`4effc57353803263f74448dfaa95aa523f8751ab`，证明 main squash 是原 P0 gate 的同一 tree。
`git diff --cached HEAD` 在本节追加前只有 PLAN/now；全树 4359 个其余 tracked 文件相同，
原 Start evidence 中 22 个 SHA-256 全匹配，P0 的 10 个源码/测试/版本化证据文件同时匹配
两 parent。P0 文档与 JSON 未修改；应用依赖、Dockerfile、配置、Start/Hono 源码与测试全部
匹配旧 PR head。auth/health/readiness、原始 Request/Response 的 multipart/binary/SSE/cancel
传输路径没有源码变化。本次以字节相同证明保留合同，没有重跑 listener 或新增 runtime 证明。

最终 first-parent diff 仅 PLAN、now 与本交付文档。本次 main-relative diff 保留原 Start 前门
实现和依赖、Dockerfile、README、配置及其 scoped/acceptance tests，另含最新 planning/handoff
和本节证据；没有新增领域操作、任务恢复、DB/schema 或 UI 改动。
`git diff --cached origin/main --stat` / `--numstat` 已检查，原 Start 源码增量保持；
1355/1356/1364/PR1591 与主 dirty tree 未触及。

完整比较记录命令为 `python3 .cache/yuk1352-main-integration/compare.py`；
script SHA-256 `5e2ac5bc1488a82796af98262241dbf638af6a8bd2b2cffb2cc7523370f31589`。
JSON 比较记录 `.cache/yuk1352-main-integration/comparisons.json` 的 SHA-256 为
`526f6e748bfaac64341334778bef0dc2d639f438eb8390cdd542776b0534e808`，文本日志 `comparisons.log` 的 SHA-256 为
`e1a919a57d85a8c6f8eaba54488c1a7ea4e2c8ca2865d1d2ac752eb37b1db6fd`。记录包含两 parent、tree、4359 文件 hash、P0 文件 hash 和
main-relative numstat。构建后 `git diff --name-only HEAD` 再次只报 PLAN/now，无生成源码漂移。

| 保留原字节的文件 | SHA-256 |
| --- | --- |
| `pnpm-lock.yaml` | `7f53823be77d0a9708de4a6d5580910b42991ddd3eb09a19e11dce83fce1e2ac` |
| `package.json` | `64cb72ef9b9c833374dc6f55f8c18db4ae99d2263861177209df0d6cc5edfecf` |
| `docs/planning/2026-10-07-yuk1338-pi-dbos-gate.md` | `a32aca2210e5f6659485d994bd1fba00aecb3ae319ab8ac0a84dacf989a08df6` |
| `docs/planning/2026-10-07-yuk1338-pi-dbos-gate.evidence.json` | `e8a3cda98b4ae0371f1ee29c7e40702c5da42ea59fd03c8f3905d2da06cbd0a0` |
| `docs/planning/evidence/2026-10-07-yuk1352-start-frontdoor.json` | `952282d385a79900c8671764702a26a3594646736b087611c2e3a06c560257e2` |

### 本次验证与限制

以下命令使用 `env` 白名单 PATH、原 HOME、树内 TMPDIR/XDG_CACHE_HOME 与
`CODEX_FULL_GATE=1`，不继承 DB/provider/token 或生产配置；未 loadEnv，树内无 `.env`。
Node 26.10.0 / pnpm 11.13.1，使用本树既有 node_modules。依赖 manifest/lock 相对 first parent
零变化，因此不做无关 frozen reinstall，原 frozen-install 证据保留。本次只改文档且源字节
匹配，沿用旧 scoped/transport 证据及其 revision，不重复 unit/DB/migration/HTTP/browser gate。

| 命令 | 结果 | 本树日志 | SHA-256 |
| --- | --- | --- | --- |
| `pnpm typecheck` | PASS / exit 0 | `.cache/yuk1352-main-integration/typecheck.log` | `36ea241c6942f1a41abb39db13194e6117c19022d769f9059b8a87960ef20ad6` |
| `pnpm lint` | PASS / exit 0 | `.cache/yuk1352-main-integration/lint.log` | `1168b44726e392e16927cc57a8f3844940df14e591c0d68c2cba86c7a63b1779` |
| `pnpm lint:ratchet` | PASS / exit 0 | `.cache/yuk1352-main-integration/lint-ratchet.log` | `058dfaa3ca09abec9e7800e4ed6b1c82faa62a66c3dbd606d108250acc6a6918` |
| `CODEX_FULL_GATE=1 pnpm build` | PASS / exit 0 | `.cache/yuk1352-main-integration/build.log` | `6245d89fa30c98b3e1304950666692975b3916adb9ca530ac0253669117358a1` |

lint 为 0 errors / 297 既有 warnings；warning ratchet 未放宽。build 产出旧 SPA、Start
client/server 与三个 CJS entry，保留既有大 chunk/bundle warning。没有完整本机 `pnpm test`。
本次本地通过不代替新 head exact CI、认证领域流程、Node24 image/rollback drill 或部署验收。
新 head CI 仍 pending，父线程独占 push/CI/host merge/Linear 及后续验收。

当前优先完成整个非 UI 迁移，UI deferred；Hono/SPA 是有 P7/YUK-1359 退出条件的过渡形态，
不是最终架构。runtime Agent TEST ONLY，automation disabled，不供个人日用。
本次没有 runtime、现有 DB、services、ports、worker、provider 操作、部署、host PR 修改、watch
或委派；仅为 T3 登记既有 PR1592 关联。没有新增 substantive P0/P1 或 actionable follow-up，
未新建票，既有 YUK-1356/P7 义务保留；用户禁止本 writer 操作 Linear，父线程负责 tracker。
正常 merge commit 完成后 writer 在 terminal 释放，不因通知自动恢复写入。


## Dependency main integration and CI audit repair

Parent integrated main `26f1015810cc3d902f6229b615d9630f05982eef` into `110f22ce88c70dfa22cdb7bddee00479053b969b` using a normal merge. PLAN/now retain the frontdoor handoff; main dependency and fixture changes are preserved. Package scripts retain Start builds and runtime entry. Start/router exact pins remain. Final lock comparison verified every main direct resolved version unchanged, with only `js-yaml@4.3.2` and `source-map-js@1.2.2` package versions absent from both parents. Mem0 patch and existing security overrides remain.

CI job 112811910457 failed dependency audit, not a route contract assertion. Start brought three high js-yaml advisories and one high source-map-js advisory. Narrow version overrides in canonical pnpm-workspace.yaml select patched versions. An initial package.json override attempt was ineffective under pnpm11 and was removed; its failed audit log is retained. Final production audit passes with 0 high/critical, 8 moderate and 2 low. No audit baseline or suppression changed.

51 scoped frontdoor/auth/SPA tests and typecheck passed with merged dependency versions. Final patched graph passed offline frozen install, lint and complete application build under Node24.19.0. No application source changed relative to the prior frontdoor implementation; new exact-head CI remains required. These are local/source checks, not authenticated business, Docker rollback or runtime acceptance. No services, database, provider or private data touched. Agent TEST ONLY purpose and disabled automation remain.

Logs in `/tmp/yuk1360-dependency-repair-20261007`:

- `start-main-install.log` SHA256 `ba2abda1c24498a1f434fad271a980804bd815188c4006cbfbc779b4fc9fefbe`
- `start-main-audit.log` SHA256 `c4c11117a5cdb625a391c69233655768b6134e696507e9330702c907ae5c914f`
- `start-main-unit.log` SHA256 `b51e20537b79ca2439d773a41e21fe6d46491370f3d762f690bb23f2a4506d65`
- `start-main-typecheck.log` SHA256 `408d32ee530bbaddc206990b7edef2b022ea717012cc652b3a2e6d21487fa363`
- `start-main-install2.log` SHA256 `3b8b62bbbde81b34da57aefea1e550dfe24428cf3f4d605afc25c960384c7940`
- `start-main-audit2.log` SHA256 `618da6bca75803969f255ad3335ef752b04ffaef3344d34e3f8671d05bb3d18c`
- `start-main-build.log` SHA256 `b0587d0cf27612a41781052d83a6d509eda9e2545395be81c491293b9da6826a`
- `start-main-frozen2.log` SHA256 `a720d2354f86aa164a430019ded3b7ec7cbd3f4b478621e92ed3e1b94f08d21d`
- `start-main-lint.log` SHA256 `4e15f428c495287f24033c3e957a2caf3d21b9d878087cca73dc0064724348a7`

## 2026-10-08 authenticated /mistakes consumer preflight

This continuation is sole-writer work in the original1352 tree. Owner7631 retains
native evidence, materials and the1359 exit inventory. The parent owns PR1592,
push/CI/review/Linear and runtime/browser acceptance. No runtime listener is started here.

UI preflight under delegated authority, before mounting edits:

- `docs/planning/2026-10-07-non-ui-migration-priority.md:9` says:
  “先完成整个非 UI 技术迁移，保留现有页面及行为；视觉设计与 UI 重写暂缓”.
- `docs/design/2026-06-04-redraw-mistakes-preflight.md` §0 says:
  “唯一 `useQuery(['mistakes'])` + 派生计数 + `<Link>` 跳转**全部保留**”.
  This is historical visual guidance; current filter/query behavior remains authoritative.
- Component types: route and shared shell mounting adapter. Existing markup, tokens,
  primitives, filters, timing, attachments, fallback text and navigation targets are reused.
- Planned source changes: `server/start/{context,mistakes-read,mistakes-function,mistakes-client}.ts`,
  `server/start/routes/{__root,mistakes}.tsx`, `server/start/vite.config.ts`, generated route tree,
  `server/frontdoor.ts`, the main-integration seam in `server/index.ts`,
  `web/src/routes/MistakesPage.tsx`, `web/src/router.tsx`, and new `web/src/RootShell.tsx`.
  Scoped auth/client/mount tests live in Start and the existing page test seams.
  PLAN/now and this delivery document record the handoff.

The additional shell overlap was reported before editing: `web/src/router.tsx` moves
its existing RootShell into `web/src/RootShell.tsx` with pathname/navigation/children
props. Both mounts consume the same shell; this does not authorize visual redesign.

### Consumer, checks and parent handoff

Fetched main `7bc216509` and normally merged it as `d98d965aa`. PLAN/now use the
newer main facts; `server/index.ts` combines Start dispatch with the newer SSE
start/stop lifecycle. All protected ingestion, records, practice, shared kernel
and global manifest files match that main. No unmerged PR1600 source was used.

`/mistakes` is now a Start component route with browser-only loading, the original
TokenGate and the shared original shell. Its injected list function calls the
actual GET server function. Every function request retains Hono token/epoch
checks; the explicit consumer guard also checks before invoking the lazy host
reader. That reader imports the DB and ingestion public operation only after
access is granted. Query validation, subject/since/question/cursor policy and the
`data/rows/page/next_cursor` envelope belong to unchanged `readMistakes`.
Host errors become Responses before the CJS/ESM boundary, preserving domain400s.
No secret is substituted for a caller header. Anonymous document rendering does
not call the reader. Asset URLs use `/_build/`; router and RPC base stay `/`.

The shell's effects and render body match the merged original after replacing
Outlet with children. Existing page markup/behavior is unchanged except its list
injection. Built SPA `/mistakes` performs a document handoff to Start, including
navigation from unported `/record`; Vite-only development temporarily keeps the
original HTTP consumer. Other routes still use the SPA fallback. Remove that dev
adapter together with old SPA dev/build/image/fallback paths only after all real
route consumers migrate and1359's behavior/rollback exit conditions pass.

The pre-PR1600 local evidence used Node24.19.0 / pnpm11.13.1 in an `env -i` whitelist with
only HOME/PATH/TMPDIR and CODEX_FULL_GATE for build. No private env is loaded.

- 11 scoped files / 75 tests pass, including auth/epoch-before-import, unchanged
  query forwarding, client401 re-gating,400/503 errors, injected subject filter,
  reset/retry/empty/deep links, old card/TokenGate, inventory and startup/shutdown.
- typecheck, lint, lint ratchet and full application build pass. Lint remains
  297 warnings/0 errors; the baseline is not changed. Existing bundle warnings remain.
- Capability boundary audit passes with zero deep cross-capability imports.
- In-process compiled dispatch checks401/503, query/cursor/envelope, operation400,
  the Start document and unrelated fallback with a controlled reader/epoch seam.
  Actual frontdoor static dispatch reads10 referenced JS/CSS assets and missing404.
  These checks open no listener and access no database/provider. Client artifacts
  contain none of `DATABASE_URL`, `postgres-js`, host-reader/auth-helper names or
  `INTERNAL_TOKEN`. They do not prove authenticated native/material/attachment behavior.
- Scoped shutdown testing uses its existing temporary child listener; no persistent
  server, shared service, container or runtime lock was started or acquired here.
- No full local `pnpm test`, disposable DB test, paid call, replay, deployment,
  push, host merge, Linear operation, new review or delegation was performed.

[Machine evidence](evidence/2026-10-08-yuk1352-start-mistakes.json) records source
and log digests. Temporary compiled/static scripts remain under this worktree's
`.cache/yuk1352-mistakes/`; their hashes are recorded. The old1352 evidence remains historical.

After the parent obtains the runtime lock and7631 supplies an isolated acceptance
DB and token, run from this worktree with the already-built outputs:

```bash
env -i HOME="$HOME" \
  PATH="/Users/yuqi/.local/share/mise/installs/node/24.19.0/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin" \
  TMPDIR=/tmp NODE_ENV=production API_PORT=18952 \
  DATABASE_URL="$YUK1352_ACCEPTANCE_DATABASE_URL" \
  INTERNAL_TOKEN="$YUK1352_ACCEPTANCE_TOKEN" \
  pnpm exec tsx server/start/acceptance-server.ts
```

The entry binds only `127.0.0.1`; change `API_PORT` for a different isolated port.
Open `http://127.0.0.1:18952/mistakes` in T3. Enter the supplied token in the retained
password field; it stays under `loom_internal_token` in that browser and travels
as `x-internal-token`. The entry loads no `.env`, starts no worker/event listener,
does no boot tool recovery or subject/config hydration, and uses the real default
Hono epoch gate and real public DB read. It is a route acceptance entry, not a
release-runtime startup proof. Supply only the required storage env separately for
7631's real attachment acceptance; never copy provider secrets into the browser.
Stop with SIGINT/SIGTERM after the parent's acceptance work.

Remaining acceptance is owned by the parent and7631: direct/refresh/record-to-mistakes
navigation; saved-token resume and401 re-gating; real native and legacy frozen rows;
subject/state/cause combinations,200+ indication and pending timer; attachment
bytes/MIME/404, Lightbox close/reopen; event/knowledge/practice navigation and return.
Use canonical runtime boot for hydrated custom subjects/config and release/SSE
acceptance. Native public-material fixes and1359 exit inventory remain7631-owned.
The parent owns push, exact-head CI, existing review budget, tracker and any release.
YUK1352 and global SPA retirement are not marked accepted or Done here.

Linear capture: no new domain defect remains from this task; mounting defects were
fixed within1352 and known consumer-exit obligations are already1359/1376. The parent
performs the tracker gate, as explicitly required by this assignment. The sole writer
is released after the final local commit; the canceled1356 dirtytree is untouched.


### Final integration of published PR1600

During this task the shared origin/main advanced to `7100dfae4` after PR1600 was
merged. The implementation was first committed as `3819a695c`, then this tree
normally merged that published main. Only PLAN/now conflicted; the latest7631
public-material source, API schema, generated client and original tests are
preserved verbatim. The only local follow-up source change adds the required
`prompt_materials: []` to the injected-page test fixture. No private contract or
records file was authored here. The adapter forwards public materials unchanged;
the existing card renderer does not gain new material UI in this mounting task.
7631 retains materials, real bytes and UI/acceptance responsibility.

Final checks on the integrated source are13 scoped files /98 tests, typecheck,
lint with297 warnings/0 errors, lint ratchet, full build and capability boundary
audit, all PASS. The compiled controlled-dispatch and real static-byte checks
also pass again. The machine evidence now refers to this7100dfae4 integration
and final log/source hashes; earlier75-test statements describe3819a695c only.
The parent startup command and remaining runtime/browser/release limitations
above are unchanged. Protected records/ingestion/practice/kernel/manifest files
have zero diff against7100dfae4. No new authorization or review round was used.

### 7631 acceptance-matrix alignment

The matrix `/tmp/yuk1376-start-acceptance-matrix-20261008.md` was read after the
source integration commit `7d26e2403610c1d5a7617557078fb6a17476ac46` was clean.
Its prerequisites and observations remain pending for the parent/7631. Candidate
source includes published7100dfae404449c7a5331c25548957da036021ad; no candidate
Docker image or live browser/runtime PASS is claimed by this writer.

The loopback command above supplies the real token/epoch/read operation and
separate authenticated subject/knowledge reads. It uses no reseeding or worker
startup. For the image rows, add only these isolated-storage variables to the
same `env -i` command, supplied by7631 through the parent's private environment:

```bash
R2_ENDPOINT="$YUK1352_ACCEPTANCE_R2_ENDPOINT" \
R2_ACCESS_KEY_ID="$YUK1352_ACCEPTANCE_R2_ACCESS_KEY_ID" \
R2_SECRET_ACCESS_KEY="$YUK1352_ACCEPTANCE_R2_SECRET_ACCESS_KEY" \
R2_BUCKET="$YUK1352_ACCEPTANCE_R2_BUCKET" \
```

The full matrix additionally requires before/after non-system table counts and
digests, with no new jobs/learning records/model runs; actual HTML/bundle token
absence; observed browser failure/retry; image byte/MIME/digest and401; and
candidate-specific route/request/browser captures. These are not replaced by
controlled dispatch/unit tests. Never submit/start practice while checking its
navigation target. Report missing fixture states or unexercised cases as pending.
The page's200+ limit remains distinct from API cursor evidence, and prompt_materials
wire completeness remains distinct from the unchanged card rendering.

`/tmp/yuk1359-w1-remaining-consumers-20261008.md` is future context only. It records
ProfileBand's goal-scoped `/api/placement/profile?goal`, learning-intent pending
proposals and after-commit best-effort hub wake, among the remaining Today/Inbox
consumers. Those obligations remain with1358/1359 and1355/1356 recovery owners;
this writer adds no route, command, recovery owner or implementation for them.
The parent first verifies this exact clean handoff, then passes the matrix to7631.

### Parent acceptance of isolated Start route (2026-10-08 JST)

Candidate `3d6273a146c40ccffc8b7677f42048bfb2e98ccf` was exercised by
the existing YUK1376 acceptance owner using isolated PG/S3 and Start port18952.
The parent verified39 source/log/input hashes, reran21 auth/read/client/page tests,
and inspected the returned HTTP, browser, artifact and database records.
The actual `/_serverFn/` request returned401 without authorization and200 with it.
Four frozen records and public materials, three images with bytes/MIME/SHA/ETag,
eight thumbnails/Lightbox, filtering/refresh/return and browser re-gating passed.
A controlled frontend503 produced a visible error; a real retry restored four rows.

Full navigation database invariance did **not** pass: opening `/practice` created
one `practice_stream_item`; the other85 tables were unchanged. The parent checked
`src/capabilities/practice/api/stream.ts`: its existing today's GET explicitly uses
`composeIfEmpty` and `materializeScoped`. This file has no candidate diff from main.
This is preserved practice initialization, not evidence that the Start mistakes
read wrote data. No new product bug is asserted from that existing behavior.
After navigation, the separate mistakes retry window left all86 tables unchanged.
The inserted row and original evidence remain intact. This distinction belongs
in the existing1359/1376 acceptance matrix; no duplicate defect ticket is needed.

All158 build artifacts were unchanged, the tree remained clean, and cleanup
records show the three isolated ports stopped and the owner lock released.
The main release was unchanged. Canonical boot, custom-subject hydration, release,
SSE, all media rendering and full SPA retirement remain unverified by this run.
No provider, worker or replay ran. The runtime evidence seal is
[evidence/2026-10-08-yuk1352-start-runtime.json](evidence/2026-10-08-yuk1352-start-runtime.json).

### Parent closeout integration (2026-10-08)

Normal merge `b70823b42` integrates main `5b11f3edb`. Only PLAN/now conflicted.
Start, web, Dockerfile and package/lock files are byte-identical to accepted
`5346f7ad0` (same executable source as the isolated route candidate). Incoming
practice typed due source is retained from main. Parent reran five focused
frontdoor/auth/read/client/page files, typecheck, lint and build: all exit0.
No runtime operation or new model call occurred. Exact-head CI remains required.

| Parent log | SHA256 |
| --- | --- |
| `/tmp/yuk1352-closeout-unit.log` | `e2b3cbb47a59a110693fe6aeb2faf0ef62f0dd85fc7eb67009108bb140b12825` |
| `/tmp/yuk1352-closeout-typecheck.log` | `36ea241c6942f1a41abb39db13194e6117c19022d769f9059b8a87960ef20ad6` |
| `/tmp/yuk1352-closeout-lint.log` | `3435080431d7a03f092431164a8b8126bb75dadc5ba904dbf04a12af4a52508b` |
| `/tmp/yuk1352-closeout-build.log` | `8ea5b2d8e8dc2e94f31b75c7eff78ad2da368487e396c1b68148f9c1dcde7044` |
