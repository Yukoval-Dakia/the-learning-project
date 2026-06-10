# ARCHITECTURE — 装进脑子的那张图

> **REV 2（D17-D20）**：架构**重写**进行中——原仓拆旧建新（绿地组装 + 采石场），不保旧行为等价。
> spec：docs/superpowers/specs/2026-06-10-architecture-redesign-design.md（REV 2 横幅 + §4 M0-M5 建造顺序）。
> 新形状导航起点 = 本文件 + `src/capabilities/index.ts`（组合根）+ `server/`（Hono 入口）+ `web/`（Vite SPA）。
> 旧树（app/、src/server、src/ai、src/ui）是**只读采石场**：按里程碑采伐入包，对应旧 surface 验收后拆除；
> 未采伐部分须持续 typecheck + test 绿（旧测试 = 资产 spec）。

## 新栈两棵树（M0 起）

- `server/` — Hono API 入口：token gate、health、**manifest→组合根真实挂载**（带 `load` thunk 的路由声明被循环 `app.on()`，零壳文件）。dev：`pnpm rw:api`（:8787）。
- `web/` — Vite SPA（TanStack Router + TanStack Query + Tailwind v4，样式暂 import 旧 globals.css）。dev：`pnpm rw:web`（:5173，/api 代理到 :8787）。
- 规则：**capability ui 不 import 路由库**——导航以 `(to: string) => void` prop 由 web 壳注入（web/src/router.tsx）。

## 内核（src/kernel/）— 六契约

| 契约 | 状态 | 位置 |
|---|---|---|
| manifest/组合 | ✅ P1 | src/kernel/manifest.ts + src/capabilities/index.ts |
| 事件存储 | ✅ P1 薄 facade（包装 writeEvent） | src/kernel/events.ts |
| 投影引擎 | ⏳ P2（practice 首用时立） | — |
| 提议生命周期 | ⏳ P2（首批 applier 迁入时立） | — |
| 能动性策略层 | ⏳ P2+ | — |
| AI 运行时 | ⏳ P2+（现 src/server/ai/runner.ts） | — |

（http.ts 是公共件不是契约。）

## capability 包（src/capabilities/）

| 包 | 状态 |
|---|---|
| agent-notes | ✅ P1 打样已迁（CONTEXT.md 在包内） |
| ingestion / practice / knowledge / notes / quiz / agency / copilot / subjects / memory / observability / shell | ⏳ 见 spec §2.3 与 §4 分期 |

## 规则（spec §2.2）

1. 包只依赖 `@/kernel/*` + 自身 + 共享 UI 件（`@/ui/primitives`、`@/ui/lib`）；包间走 manifest 公共接口，禁深层 import。
2. 事实经事件，查询经接口。
3. 横切面（today/工作台块、Copilot 工具）由包 manifest 贡献，外壳只组装。
4. **迁移期豁免**：kernel facade 可包装遗留 `src/server/**`；capability 暂可 import `@/db/client`/`@/db/schema`（schema 切片 P2 起）。

## 测试约定（新形状）

`src/kernel/**` 与 `src/capabilities/**`：`*.unit.test.ts` 自动进无 DB 快车道，
`*.db.test.ts` 自动进 testcontainer 车道。命名即分区，零 allowlist。
