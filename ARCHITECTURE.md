# ARCHITECTURE — 装进脑子的那张图

> 架构重设计进行中（spec：docs/superpowers/specs/2026-06-10-architecture-redesign-design.md）。
> 本文件 + `src/capabilities/index.ts`（组合根 = 迁移进度表）是新形状的导航起点；
> 未迁部分仍按 CLAUDE.md「Layering」一节阅读。

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
