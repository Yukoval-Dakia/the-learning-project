# src/kernel — 内核契约

> capability 架构的契约层。manifest 保持声明式；`events/` 是明确边界内的事件 envelope 存储本体，可依赖 core event schema、db 与 Drizzle。YUK-892 起 `tools/`、`read-models/`、`records/` 与 `proposals/` 的 engine 模块承载跨 capability 共享的 DomainTool 契约、只读投影、learning-record 存取与 proposal inbox/writer 机制。

## WHERE TO LOOK
| 文件 | 职责 |
|------|------|
| `manifest.ts` | `CapabilityManifest` 接口、`defineCapability()`、`validateComposition()`；声明包名 / event actions / api routes / jobs / proposals / copilotTools / ui 的唯一归属 |
| `host-operation.ts` + `records/conversation-confirmation-assessment.ts`、`records/review-answer-binding.ts`、`read-models/review-due.ts`、`tools/learning-content-validation.ts` | Practice 在启动时经 `installPracticeHostOperations()` 安装的宿主端口（Copilot 调用）；未安装即抛 `HostOperationNotInstalledError`，调用方不得把它当普通读失败降级 |
| `read-models/model-admission.ts` | 判分模型准入的读侧：active 切片、题组→科目查找；当前模型 pin 表由 practice 判分 owner 的 `installModelAdmissionPins()`（`capabilities/practice/grading/server/model-admission-pins.ts`，经 practice `public.ts` 转出）在 API、Start 验收入口、worker 与维护脚本启动时安装；未安装时只要存在 active 切片即抛错（无 active 切片时 pin 不参与判定）。切片登记与退役归 `capabilities/practice/grading/server/model-slice-registry` |
| `events/` | event envelope 的完整读写 API、修正投影（corrections / effective-truth）和 deterministic scope tagging；唯一 event INSERT owner |
| `tools/` | DomainTool 契约（types / allowlists / budgets / context-throttle），central registry 与 capability tool 共享 |
| `read-models/` | 跨 capability 只读投影（failure attempts、failure-learning knowledge context、question activity、cause policy、knowledge tree/subject 解析、目标定位范围与种子根锚点 `placement-scope`、questions 列表、daily review plan inputs、intervention preparation stage、note section projection、练习会话打开态 `practice-session-open`、学习者作答/学习活动集合与学科解析及最长连错 `learner-activity`） |
| `memory-brief-regen.ts` | memory brief regen 队列契约：队列名、`memory.regen.<scope>` singleton key 与槽长（`subject:*` 4 小时，其余 6 分钟）；Agency 挂 handler，Agency 与 Practice 都经 `enqueueMemoryBriefRegen` 入队 |
| `scheduling.ts` + `records/scheduling-state.ts` | 遗忘引擎选择（`FORGETTING_ENGINE`）与保持率读数；`material_fsrs_state` 唯一存取（读投影、enroll/upsert/退役/merge，锁序不变）。写入调用方仍只有结算等既有 owner（ADR-0037）。候选引擎重建由结算经 `installSchedulingCandidateRebuild()` 在 API / worker / acceptance 启动时安装；未安装时只在候选引擎需要重建的分支抛 `HostOperationNotInstalledError`，默认 `fsrs` 引擎不受影响 |
| `records/mastery-state.ts` | 在线 mastery 诊断的完整 attempt 更新、显式 upsert 与单 KC merge retirement；跨面结算、恢复和 merge 编排仍归调用方 |
| `records/intervention-diagnostic-materialize.ts` | 干预诊断题物料化与退役：题行谱系、草稿/准入门、一次性发布、当日流安置（锁在 `locks/intervention-diagnostic-delivery.ts`）。Agency 在干预事务内调用；Practice 在 worker 启动时绑定当日流日期、判分活动与题目排程入学/退役 |
| `records/intervention-package-author.ts` | 干预题目包的一次准备尝试：准备态守卫、科目档案、付费作者阶段、再次守卫、付费复检阶段、确定性校验。Practice 只提供两个付费阶段 |
| `records/knowledge-tag.ts` | match-or-propose KC 标注：相似度匹配或建 pending 子 KC 及审计事件；embedder 与命名由调用方注入，kernel 不调 provider。检索与阈值在 `read-models/knowledge-similarity.ts` |
| `records/mem0-collection.ts` | mem0 pgvector collection 表名解析与固定列：Mem0 客户端与备份恢复共用，保证恢复落到客户端读取的同一张表 |
| `records/` | 共享 learning-record 读/迁移模型（queries / record-processing / types）、typed-state 存取与 `conjecture-prediction-scoring.ts` 单探针评分规则 |
| `proposals/` | proposal 生命周期 registry + inbox / writer / producers / signals engine（kernel 共享机制）；`decision-protocol.ts` 是接受与驳回共用的裁决事务模板 |
| `locks/registry.ts` | 命名 advisory-lock 键模板与键派生。不取锁、不证明顺序。contract-epoch 状态迁移由 `locks/contract-epoch-transition-lock.ts` 消费；迁移演练竞争写者 fence 由 `locks/migration-apply-fence.ts` 消费。learning-state write 由 `src/db/learning-state-lock.ts` 消费；provider-attempt 三族（hashtextextended salt 0）由 `src/server/ai/provider-attempt-lock.ts` 消费；探针 serve cap、probe question、conjecture fold 由 `src/capabilities/agency/server/conjecture/probe-lock.ts` 消费；intervention instance / corrections:all / source 由 `src/capabilities/agency/server/intervention/intervention-lock.ts` 消费（store、恢复与 probe-result 订阅）；同一 corrections:all / source 键由 `src/kernel/events/correction-lock.ts` 消费（`writeEvents` 与 review-answer-consumer）；proposal decision 由 `proposals/applier-helpers.ts` 的 `acquireProposalDecisionLock` 消费 |
| `cost.ts` / `canonical-json.ts` | 共享数值与序列化 helper |
| `parse-task-output.ts` / `generation-prompt-support.ts` | TaskSpec 文本输出的 JSON 解析与 schema 校验；出题类 prompt 的题型词表与科目 rubric 规范段 |
| `object-storage.ts` | 共享 R2/S3 对象 I/O：完整 client 接口、SDK 命令/响应适配与 lazy singleton；不拥有资产引用、数据库事务或付费策略 |
| `http.ts` | 公共 HTTP helper（公共件，非契约） |
| `judge.ts` / `placement.ts` / `placement-persistence.ts` | 根目录过渡门面：只 re-export 现有消费者实际使用的符号，不得新增符号。`judge.ts` 只剩 ingestion / agency 用到的 6 个判题入口 |

## CONVENTIONS
- `JobHandlerFactory` 参数刻意用 `any`：kernel 不 import pg-boss 类型，让 capability 包的 `buildXHandler(db)` 工厂能零适配注册（注释已说明 variance escape hatch）。
- manifest 是**声明元数据 + 组合期校验**，不是运行时插件总线；组合根是静态数组 `src/capabilities/index.ts`。
- proposal kind 的强度 C 档 ⟺ 没有 accept applier；退役类别留在 `aiProposalKinds` 词表里，payload 成员永久保留，驳回和撤回仍可用。由 `acceptSupportedProposalKinds` 从 core 强度表派生、`validateComposition()` 校验 owner accept 声明、完整组合根入口的 `assertProposalKindsOwned()` 校验每类恰有 owner，不靠注释维持。
- 提议的接受与驳回走 `proposals/decision-protocol.ts`：kernel 先取 `proposal_decision` 锁，锁后重查 rate 与更正状态（已撤回的提议不能再写入接受或驳回），写唯一一条 rate 事件和裁决信号；owner 只提供领域效果，自己的领域锁在效果内、排在裁决锁之后。owner 不再手写这段锁、重查与 rate。
- `tools/`、`read-models/`、`records/`、`proposals/` 与 `cost.ts` 只允许依赖 `@/core/*`、`@/db/*`、`@/subjects/*`、`@/kernel/*`、`@/ai/*`、`drizzle-orm`、`zod`；禁止 import `@/server/*` 或 `@/capabilities/*`（kernel 不隐藏债务，只下沉真正共享的 seam — YUK-892）。
- `object-storage.ts` 是 server-only 共享对象 I/O 的唯一 canonical 端口，允许直接依赖 `@aws-sdk/client-s3`；capability、server 与维护 CLI 可直接消费其既有 `R2Client`、`createR2Client`、`getR2`，不经 capability 转出。此许可仅限该文件与三符号；资产 ref、授权、锁、readback 证明、补偿/恢复与 provider/付费策略仍由原 owner 持有；浏览器不得 import；不在 kernel 根 barrel 转出。
- 契约按「第二实例原则」扩展：jobs/proposals/copilotTools/ui 等字段在各自第一个需求包迁入时才加入。
- `locks/` 只放命名键模板与派生。不取锁、不拒绝未登记键、不记录获取顺序。
- `RouteHandler` 形态兼容有参与无参：`(req, params) => Promise<Response>`，无参 handler 可忽略 `params`。

## ANTI-PATTERNS
- manifest 代码禁止业务逻辑或 DB 调用；`events/` 仅允许 event envelope 所需的 `@/core/schema/event`、`@/db/*`、`drizzle-orm`，以及 correction 锁键所需的 `@/kernel/locks/registry`；不得 import `@/server/*` 或 `@/capabilities/*`。
- 禁止 capability 包之间深层 import；包间走 manifest 公共接口。
- 禁止新增契约字段而没有真实使用方（反框架护栏）。
- 禁止在 kernel 的 manifest/http 公共件 import `@/db/client`、`@/server/*` 等运行时依赖；`events/` 适用上方窄化依赖契约。
