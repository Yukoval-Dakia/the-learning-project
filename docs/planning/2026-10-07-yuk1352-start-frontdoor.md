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
