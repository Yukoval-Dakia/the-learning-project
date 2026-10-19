# YUK-1567 后续 — successor 输入的 subject profile 严格活水合

Stage1 付费输入正确性 P1 修复。姊妹文件：
`2026-10-19-yuk1567-paid-effect-void-reauthorization.md`（协议本体）。

## 缺陷

`buildSuccessorInput`（`reauthorization.ts`）用同步全局
`resolveSubjectProfile(first-linked-knowledge.domain)` 取 profile。该读的是
import 期代码地板，除非进程已跑过 `hydrateSubjectRegistryFromDb`：

- reopen `--plan` CLI 从不水合 → 冻结 `math@1.0.0` 代码地板；
- backlog driver / worker boot 水合过 → 同输入得出 `jt:trait@<rev>` 装配档；
- release 用**同一**求值函数重验，"错但一致"的 profile 照样过 digest 比
  对——正确性靠不住环境巧合；
- 非空未知 domain 静默落 `general`（`SubjectRegistry.resolve` 的兜底语义），
  把语义错误的 profile 绑进付费身份；
- `hydrateSubjectRegistryFromDb` 本身是 never-throws 设计（42P01/DB down/坏
  行 → WARN + 地板/last-good），**调用它不等于目标已权威水合**——必须看
  report；
- `report.hydrated` 只证明装配成功：live payload 不过 schema 的 trait 仍经
  journal_fallback / code_seed 降级链装进 profile（`hydrated` 照样收录）。
  付费输入必须逐 trait 查溯源（`degraded === null`），不能只看 version
  （render/scheduling trait 不进版本号）。

## 修复

一处通用制备缝，plan 与 release 共用，没有第二份 CLI bootstrap：

```text
evaluateAdmissionVoidGroup (plan tx / release tx 同缝)
└─ buildSuccessorInput
   └─ resolveSubjectProfileStrictLive(tx, domain)   ← kernel read-model
      ├─ new SubjectRegistry()                      ← 私有实例，非全局单例
      ├─ hydrateSubjectRegistryFromDb(tx, registry) ← 同一事务上下文（kernel
      │                                              subject-hydration 引擎）
      └─ 严格收口：report.hydrated 成员 + 全部六 trait
         resolutions degraded === null（live payload）
         → 否则 throw → evaluate.failures → plan 判不合格 /
         release 在锁内 throw，事务整体回滚
```

- **domain 来源不变**：`question.knowledge_ids[0] → knowledge.domain`，与
  claim 期 `subjectProfileFor`（`question_admission_run.ts`）同口径。
- **空/缺 domain → `general`**：既有默认语义保留；但 `general` 也必须 strictly
  live——默认身份不豁免权威水合。
- **非空 domain**：经水合后私有 registry 的 `resolveKnownSubjectId`
  （alias-aware）取 canonical id；解析不到 → 拒绝冻结（不再静默落
  `general`）；解析到但该 id 不在 `report.hydrated`（`skipped` /
  `builtinFloor` / 无 DB 行）或其 resolutions 含任何降级 trait
  （journal_fallback / code_seed）→ 拒绝。
- **私有 registry**：冻结输入不依赖进程级可变单例——并发 60s refresh /
  其它异步水合不能在中途换掉 profile（内存隔离）。注意边界：传入 Tx 共享
  的是调用方事务上下文与锁会话，**不是**事务级快照——READ COMMITTED 下
  水合的若干 SELECT 各自取语句级快照；隔离性由私有 registry 提供。

## kernel read-models 归位（R1 架构修复）

capability → server/subjects 是 baseline 不允许的边；共享引擎下沉到
`src/kernel/read-models/`（合同允许的依赖方向）：

- `subject-hydration.ts`：完整水合/装配引擎（原 `server/subjects/hydrate.ts`
  本体）。`db` 为必传参（kernel 不 import db/client 运行时值，无 runtime env
  依赖）；`HydrationReport` 新增 `resolutions` 逐 trait 溯源字段（strict
  消费者的 live-provenance 判据，默认输出/降级语义不变）。全局
  resolution-cache 仅在目标是默认 registry 时发布——私有快照不进全局读面。
- `subject-trait-resolutions.ts`：resolution cache 本体（原
  `server/subjects/resolution-cache.ts`）。
- `server/subjects/hydrate.ts` / `resolution-cache.ts`：兼容入口——
  defaultDb 缺省、`startSubjectRefresh` 接线、全部 re-export 保持，既有
  boot/refresh/管理写面/脚本/测试导入面不变（observability/shell →
  server/subjects 既有 baseline 边维持原状）。
- `kernel/read-models/subject-profile.ts`：新增
  `resolveSubjectProfileStrictLive`——付费缝的唯一 strict 读点；
  reauthorization 经它调用（dynamic import，同文件既有 lazy 风格）。

同一引擎同时服务普通 bootstrap 与 strict 付费消费；无平行实现、无
kernel→server facade。

## 对存量冻结计划的影响（设计意图，非回归）

旧 plan 冻结的若是代码地板 profile（如 `math@1.0.0`），修复后 release 重验
必然得出不同的 `successorInputDigest` → `plan drifted since freeze — re-run
the planner` → 必须显式重新 plan/审批。这正是协议要求的：权威装载修复后
不一致的已批计划被拒，绝不静默改写或自动再授权。本 PR 不触碰任何已冻结
artifact 或 paid 行。

## 验证边界

`NOT_RUN`：runtime/DB/TEST/provider 行为未验证（本 lane 约束禁止 DB 调用与
运行探针）。已跑：`pnpm typecheck`、`pnpm lint`、`pnpm build`、
`pnpm audit:capability-boundaries` 及既有静态 audit 组。
