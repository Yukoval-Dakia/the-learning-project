# server — Hono API 与组合根

> 新栈后端入口。`server/app.ts` 把 capability manifest 声明的路由循环挂载成 Hono 实例；`server/index.ts` 负责 loadEnv、serve、可选同进程 worker。业务逻辑**不**住这里，住在 `src/capabilities/*/api/`。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `index.ts` | 入口：loadEnv → warnFlipOrder → `buildHonoApp(capabilities)` → `serve()`；设 `RW_FRONTDOOR=1` 时由 Start 前门托管 built 页面，设 `RW_FRONTDOOR=dev`（仅 `dev:local`）时经 `dev-frontdoor.ts` 用 Vite dev server 托管（HMR）；`RW_WORKER=1` 时同进程启 worker |
| `app.ts` | 组合根工厂：`buildHonoApp()` 挂载 token gate、`/api/health`、`/api/ready`、所有 manifest route；`toHonoPath()` 把 `[id]` 转成 `:id` |
| `build-commit.ts` | 镜像 `BUILD_COMMIT` 的读取：`/api/ready` 的 `commit` 只回 9 位；文件缺失或不是 40 位小写 hex 时为 null |
| `composed-routes.ts` | 跨 capability 组装的路由 handler（manifest 声明了路由但不带 `load`）：按 operationId 匹配，缺 handler 时 `buildHonoApp` 抛错，孤儿 handler 由启动入口的 `assertComposedRoutesDeclared` 拦下 |
| `dev-frontdoor.ts` | dev-only：Vite middleware 模式前门，生产 bundle 不引入；复用 `frontdoor.ts` 的 `buildFrontdoor` |
| `frontdoor.ts` / `start/` | 固定 Start fetch 前门；通过 request context 调原 Hono app，Start 独立 TS program |
| `built-asset-cache.ts` | 带内容哈希的 `/_build/assets/*` 返回一年 immutable 缓存；js/css 按 Accept-Encoding 选 `build:start` 生成的 `.br`/`.gz`。页面 HTML、无哈希资源和 `/api/*` 不走这组缓存 |
| `env.ts` | `.env` / `.env.local` 加载（API / Vite / worker 三进程统一） |

## CONVENTIONS
- `/api/*` 统一走 `x-internal-token` SHA-256 timing-safe 比较；`/api/health` 与 `/api/ready` 豁免。
- `/api/ready` 的 `commit` 来自镜像内 `BUILD_COMMIT`（构建参数 `TLP_SOURCE_COMMIT`），只回前 9 位。`/api/health` 仍只回 `{ok:true}`。
- `pnpm dev:local` 不读 `.env*` 的 `INTERNAL_TOKEN`：显式 shell 环境优先，否则每次启动生成随机值，打印在启动日志里，并注入 API、worker 及前门子进程；直跑 `rw:api` / `worker:dev` 仍按 `loadEnv()` 从文件加载。
- route handler 是 `(req: Request, params: Record<string, string>) => Promise<Response>` 形态；`params` 由 Hono `c.req.param()` 透传。
- `route.load` 是懒加载 thunk：manifest 保持纯元数据，组合根首次请求时才解析 handler，之后缓存复用。
- `RW_WORKER=1` 时 `server/index.ts` 同进程启动 pg-boss worker。`pnpm dev:local` 的 API 子进程固定 `RW_WORKER=0`，只由 `worker:dev` 消费；单独 `pnpm rw:api` 仍是单进程兜底。生产 compose 用独立 worker 容器，不设 `RW_WORKER`。
- built Web 前门：设 `RW_FRONTDOOR=1`（镜像内默认设），Start `/api/$` 调原 `app.fetch`；无旧 SPA 回落，未匹配路径 404。
- Start request/function middleware 的授权只能复用 Hono `/api/auth/check`（token + epoch），不能自行授予权限或复制业务规则。

## ANTI-PATTERNS
- 别把领域逻辑直接塞进 `server/`——路由只负责挂载，handler 在 capability 包里。
- 别在 manifest route 之外硬编码新路由；新增面必须走 capability `manifest.ts`。
- 别把组合根当作放置通用工具函数的地方；共享工具去 `src/core/` 或 `src/ui/lib/`。
