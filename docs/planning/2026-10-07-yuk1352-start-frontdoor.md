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
