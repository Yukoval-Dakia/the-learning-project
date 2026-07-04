# src/kernel — 内核契约

> capability 架构的契约层。只声明 manifest 结构、组合期校验和薄 facade；**无业务逻辑、无 IO、不 import pg-boss/drizzle 运行时类型**。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | `CapabilityManifest` 接口、`defineCapability()`、`validateComposition()`；声明包名 / event actions / api routes / jobs / proposals / copilotTools / ui 的唯一归属 |
| `events.ts` | P1 薄 facade：包装 `writeEvent`，kernel 侧不暴露具体 schema |
| `http.ts` | 公共 HTTP helper（公共件，非契约） |
| `manifest.unit.test.ts` / `composition.unit.test.ts` | 契约与组合唯一性校验 |

## CONVENTIONS
- `JobHandlerFactory` 参数刻意用 `any`：kernel 不 import pg-boss 类型，让 capability 包的 `buildXHandler(db)` 工厂能零适配注册（注释已说明 variance escape hatch）。
- manifest 是**声明元数据 + 组合期校验**，不是运行时插件总线；组合根是静态数组 `src/capabilities/index.ts`。
- 契约按「第二实例原则」扩展：jobs/proposals/copilotTools/ui 等字段在各自第一个需求包迁入时才加入。
- `RouteHandler` 形态兼容有参与无参：`(req, params) => Promise<Response>`，无参 handler 可忽略 `params`。

## ANTI-PATTERNS
- 禁止在 kernel 里放业务逻辑或 DB 调用。
- 禁止 capability 包之间深层 import；包间走 manifest 公共接口。
- 禁止新增契约字段而没有真实使用方（反框架护栏）。
- 禁止在 kernel 里 import `@/db/client`、`@/server/*` 等运行时依赖（`http.ts` 等纯公共件除外）。
