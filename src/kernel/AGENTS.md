# src/kernel — 内核契约

> capability 架构的契约层。manifest 保持声明式；`events/` 是明确边界内的事件 envelope 存储本体，可依赖 core event schema、db 与 Drizzle。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | `CapabilityManifest` 接口、`defineCapability()`、`validateComposition()`；声明包名 / event actions / api routes / jobs / proposals / copilotTools / ui 的唯一归属 |
| `events/` | event envelope 的完整读写 API、修正投影和 deterministic scope tagging；唯一 event INSERT owner |
| `http.ts` | 公共 HTTP helper（公共件，非契约） |
| `manifest.unit.test.ts` / `composition.unit.test.ts` | 契约与组合唯一性校验 |

## CONVENTIONS
- `JobHandlerFactory` 参数刻意用 `any`：kernel 不 import pg-boss 类型，让 capability 包的 `buildXHandler(db)` 工厂能零适配注册（注释已说明 variance escape hatch）。
- manifest 是**声明元数据 + 组合期校验**，不是运行时插件总线；组合根是静态数组 `src/capabilities/index.ts`。
- 契约按「第二实例原则」扩展：jobs/proposals/copilotTools/ui 等字段在各自第一个需求包迁入时才加入。
- `RouteHandler` 形态兼容有参与无参：`(req, params) => Promise<Response>`，无参 handler 可忽略 `params`。

## ANTI-PATTERNS
- manifest 代码禁止业务逻辑或 DB 调用；`events/` 仅允许 event envelope 所需的 `@/core/schema/event`、`@/db/*` 与 `drizzle-orm`，不得 import `@/server/*` 或 `@/capabilities/*`。
- 禁止 capability 包之间深层 import；包间走 manifest 公共接口。
- 禁止新增契约字段而没有真实使用方（反框架护栏）。
- 禁止在 kernel 的 manifest/http 公共件 import `@/db/client`、`@/server/*` 等运行时依赖；`events/` 适用上方窄化依赖契约。
