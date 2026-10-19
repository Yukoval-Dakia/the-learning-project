# YUK-1567 后续 — successor 输入的 subject profile 按事务快照水合

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
  report。

## 修复

一处通用制备缝，plan 与 release 共用，没有第二份 CLI bootstrap：

```text
evaluateAdmissionVoidGroup (plan tx / release tx 同缝)
└─ buildSuccessorInput
   └─ resolveSuccessorSubjectProfile(tx, domain)          ← 新增
      ├─ new SubjectRegistry()                            ← 私有实例，非全局单例
      ├─ hydrateSubjectRegistryFromDb(tx, registry)       ← 同一 tx 快照
      └─ 严格收口（fail closed → evaluate.failures → plan
         判不合格 / release 在锁内 throw，事务整体回滚）
```

- **domain 来源不变**：`question.knowledge_ids[0] → knowledge.domain`，与
  claim 期 `subjectProfileFor`（`question_admission_run.ts`）同口径。
- **空/缺 domain → `general`**：既有默认语义保留；但 `general` 也必须出现
  在本轮 `report.hydrated` 里——默认身份不豁免权威水合。
- **非空 domain**：经水合后私有 registry 的 `resolveKnownSubjectId`
  （alias-aware）取 canonical id；解析不到 → 拒绝冻结（不再静默落
  `general`）；解析到但该 id 不在 `report.hydrated`（`skipped` /
  `builtinFloor` / 无 DB 行）→ 拒绝。`builtinFloor` 是显式降级回代码档，
  对付费输入同样不算权威。
- **私有 registry + tx 快照**：冻结输入不受并发 60s refresh / 其它异步水合
  影响——acceptance 里的"mutable singleton boundary"由实例隔离天然满足，
  不是新增并行实现（`SubjectRegistry` / `hydrateSubjectRegistryFromDb` /
  `resolveKnownSubjectId` 全是既有 API）。

## hydrate.ts 的最小 API 扩展

- `hydrateSubjectRegistryFromDb(db: Db | Tx, registry?)`：hydrate 只走 select
  读面，`Tx` 与 `Db` 查询 API 同形；放开让付费缝在调用方事务快照内水合。
  所有既有调用方（server boot / worker boot+refresh / 管理写后重装 / 脚本）
  签名兼容、行为不变。
- `replaceSubjectTraitResolutions` 只在 `registry ===
  getDefaultSubjectRegistry()` 时发布：resolution-cache 描述的是全局默认
  registry 的装配溯源，私有 registry 的快照不得覆盖全局读面。

## 对存量冻结计划的影响（设计意图，非回归）

旧 plan 冻结的若是代码地板 profile（如 `math@1.0.0`），修复后 release 重验
必然得出不同的 `successorInputDigest` → `plan drifted since freeze — re-run
the planner` → 必须显式重新 plan/审批。这正是协议要求的：权威装载修复后
不一致的已批计划被拒，绝不静默改写或自动再授权。本 PR 不触碰任何已冻结
artifact 或 paid 行。

## 验证边界

`NOT_RUN`：runtime/DB/TEST/provider 行为未验证（本 lane 约束禁止 DB 调用与
运行探针）。已跑：`pnpm typecheck`、`pnpm lint`、`pnpm build`。
