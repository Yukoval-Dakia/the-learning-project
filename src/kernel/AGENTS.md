# src/kernel — 内核契约

> capability 架构的契约层。manifest 保持声明式；`events/` 是明确边界内的事件 envelope 存储本体，可依赖 core event schema、db 与 Drizzle。YUK-892 起 `tools/`、`read-models/`、`records/` 与 `proposals/` 的 engine 模块承载跨 capability 共享的 DomainTool 契约、只读投影、learning-record 存取与 proposal inbox/writer 机制。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | `CapabilityManifest` 接口、`defineCapability()`、`validateComposition()`；声明包名 / event actions / api routes / jobs / proposals / copilotTools / ui 的唯一归属 |
| `events/` | event envelope 的完整读写 API、修正投影（corrections / effective-truth）和 deterministic scope tagging；唯一 event INSERT owner |
| `tools/` | DomainTool 契约（types / allowlists / budgets / context-throttle），central registry 与 capability tool 共享 |
| `read-models/` | 跨 capability 只读投影（failure attempts、failure-learning knowledge context、question activity、cause policy、knowledge tree/subject 解析、questions 列表、daily review plan inputs、intervention preparation stage） |
| `records/mastery-state.ts` | 在线 mastery 诊断的完整 attempt 更新、显式 upsert 与单 KC merge retirement；跨面结算、恢复和 merge 编排仍归调用方 |
| `records/` | 共享 learning-record 读/迁移模型（queries / record-processing / types）、typed-state 存取与 `conjecture-prediction-scoring.ts` 单探针评分规则 |
| `proposals/` | proposal 生命周期 registry + inbox / writer / producers / signals engine（kernel 共享机制） |
| `locks/registry.ts` | 命名 advisory-lock 键模板与键派生。不取锁、不证明顺序。learning-state write 由 `src/db/learning-state-lock.ts` 消费；provider-attempt 三族（hashtextextended salt 0）由 `src/server/ai/provider-attempt-lock.ts` 消费；intervention store 三族（instance / corrections-all / source，同为 salt 0）由 `src/capabilities/agency/server/intervention/intervention-lock.ts` 消费 |
| `cost.ts` / `canonical-json.ts` | 共享数值与序列化 helper |
| `object-storage.ts` | 共享 R2/S3 对象 I/O：完整 client 接口、SDK 命令/响应适配与 lazy singleton；不拥有资产引用、数据库事务或付费策略 |
| `http.ts` | 公共 HTTP helper（公共件，非契约） |
| `manifest.unit.test.ts` / `composition.unit.test.ts` | 契约与组合唯一性校验 |

## CONVENTIONS
- `JobHandlerFactory` 参数刻意用 `any`：kernel 不 import pg-boss 类型，让 capability 包的 `buildXHandler(db)` 工厂能零适配注册（注释已说明 variance escape hatch）。
- manifest 是**声明元数据 + 组合期校验**，不是运行时插件总线；组合根是静态数组 `src/capabilities/index.ts`。
- `tools/`、`read-models/`、`records/`、`proposals/` 与 `cost.ts` 只允许依赖 `@/core/*`、`@/db/*`、`@/subjects/*`、`@/kernel/*`、`@/ai/*`、`drizzle-orm`、`zod`；禁止 import `@/server/*` 或 `@/capabilities/*`（kernel 不隐藏债务，只下沉真正共享的 seam — YUK-892）。
- `object-storage.ts` 是 server-only 共享对象 I/O 的唯一 canonical 端口，允许直接依赖 `@aws-sdk/client-s3`；capability、server 与维护 CLI 可直接消费其既有 `R2Client`、`createR2Client`、`getR2`，不经 capability 转出。此许可仅限该文件与三符号；不得扩展为任意 SDK/runtime 依赖，资产 ref、授权、锁、readback 证明、补偿/恢复与 provider/付费策略仍由原 owner 持有。浏览器不得 import；不在 kernel 根 barrel 转出。
- 契约按「第二实例原则」扩展：jobs/proposals/copilotTools/ui 等字段在各自第一个需求包迁入时才加入。
- `locks/` 只放命名键模板与派生。不取锁、不拒绝未登记键、不记录获取顺序。
- `RouteHandler` 形态兼容有参与无参：`(req, params) => Promise<Response>`，无参 handler 可忽略 `params`。

## ANTI-PATTERNS
- manifest 代码禁止业务逻辑或 DB 调用；`events/` 仅允许 event envelope 所需的 `@/core/schema/event`、`@/db/*` 与 `drizzle-orm`，不得 import `@/server/*` 或 `@/capabilities/*`。
- 禁止 capability 包之间深层 import；包间走 manifest 公共接口。
- 禁止新增契约字段而没有真实使用方（反框架护栏）。
- 禁止在 kernel 的 manifest/http 公共件 import `@/db/client`、`@/server/*` 等运行时依赖；`events/` 适用上方窄化依赖契约。
