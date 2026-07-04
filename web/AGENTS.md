# web — Vite SPA 壳层

> 前端工程根 = `web/`。React 19 + TanStack Router + TanStack Query + Tailwind v4 CSS-first。dev 经 Vite proxy 把 `/api` 打到 Hono :8787。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `src/main.tsx` | SPA 入口：QueryClient + TokenGate + RouterProvider |
| `src/router.tsx` | TanStack Router 路由表 + `RootShell`（sidebar / topbar / mobile tabbar / CopilotDock / CommandPalette） |
| `src/TokenGate.tsx` | `x-internal-token` 输入与本地缓存 |
| `src/globals.css` | Tailwind v4 CSS-first 入口（含主题变量与 shell-copilot-mount 等钩子） |
| `vite.config.ts` | root=`web/`，`@` → `../src`，dev `/api` proxy → :8787，build outDir=`dist` |

## CONVENTIONS
- **capability ui 不 import 路由库**。导航以 `(to: string) => void` prop 由 `web/src/router.tsx` 注入；capability 包只负责页面组件。
- 页面组件放在 `src/capabilities/<name>/ui/`，在 `web/src/router.tsx` 统一 import 并绑定路由。
- 全局 chrome（sidebar/topbar/CopilotDock/CommandPalette）属于 `web/` 壳层，不归 capability 包。
- 主题持久化 key = `loom-theme`，mount 时应用到 `<html data-theme>`。

## ANTI-PATTERNS
- 浏览器代码**不持** provider key——所有 AI 调用走 `/api/*`。
- 别在客户端直接 import `src/server/*`（server-only）。
- 别在 capability 包里写 `<Link>` 或 `useNavigate`；这是壳层特权。
- 别把路由查询状态管理做得过度复杂；简单 query 用 `window.location` + `router.history.replace` 即可。
