# web — Start 路由共用的壳层资源

> 没有独立前端工程或路由表：页面由 `server/start/routes/` 的 TanStack Start 路由提供（`pnpm build:start` → `dist/start`）。本目录只放 Start 路由 import 的共用壳层。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `src/RootShell.tsx` | 工作台根壳（sidebar / topbar / mobile tabbar / 学习伙伴 CompanionMount / CommandPalette）；由 `StartWorkbenchShell` 挂载 |
| `src/TokenGate.tsx` | `x-internal-token` 输入与本地缓存 |
| `src/globals.css` | Tailwind v4 CSS-first 入口（含主题变量与 shell-copilot-mount 等钩子） |
| `src/fonts/` | 随 `globals.css` 打包的字体 |
| `src/vite-env.d.ts` | `vite/client` 类型引用（Start tsconfig 纳入） |

## CONVENTIONS
- **capability ui 不 import 路由库**。导航以 `(to: string) => void` prop 由 `server/start/routes/` 注入；capability 包只负责页面组件。
- 页面组件放在 `src/capabilities/<name>/ui/`，在 `server/start/routes/` 绑定路由。
- 全局 chrome（sidebar/topbar/学习伙伴挂载位/CommandPalette）属于本目录壳层，不归 capability 包。
- 主题持久化 key = `loom-theme`，mount 时应用到 `<html data-theme>`。

## ANTI-PATTERNS
- 别在客户端直接 import `src/server/*`（server-only）。
- 别在 capability 包里写 `<Link>` 或 `useNavigate`；这是壳层特权。
