# ADR-0015: `learning_record` + `memory_brief_note` 作为一等领域实体

**Status:** Accepted
**Date:** 2026-05-22
**Supersedes:** —
**Superseded by:** —
**Related:** ADR-0005（single-owner write paths）/ ADR-0006 v2（event substrate）/ ADR-0008（learning_session 信封）/ ADR-0014（generalized activity & capability registry）/ Plan 2026-05-18 `learning-data-loop`

## Context

2026-05-18 `learning-data-loop` plan 引入了两张持久化表（migration `drizzle/0007_learning_record_loop.sql`）：

- `learning_record`（`src/db/schema.ts:223-255`）：一行 = 一次具体的学习活动 tag（做了某题 / 读了某 atomic note / Active Teaching 一个 turn 完成）。挂多种外键 — `origin_event_id` / `attempt_event_id` / `question_id` / `learning_item_id` / `artifact_id` / `source_document_id` / `subject_id`，是 event 链路在用户视角的"语义聚合点"。
- `memory_brief_note`（`src/db/schema.ts:257-282`）：按 `scope_key` 唯一的滚动学习记忆摘要，三段窗口（`recent_week_md` / `recent_months_md` / `long_term_md`）+ 对应的 evidence id 列表。**写路径由 ADR-0017 接管**，归一 `src/server/memory/brief.ts`（per ADR-0017，Phase B per YUK-37）；Dreaming agent 仍是逻辑 owner，但实施位置从原文的 `src/server/dreaming/` 迁至 `src/server/memory/`。

但 ADR 序列只覆盖到 ADR-0014：

- ADR-0006 v2 覆盖 `event` 不可变 action log。
- ADR-0008 覆盖 `learning_session` 多类型信封。
- 没有 ADR 追认 `learning_record` / `memory_brief_note` 为什么单独存在、为什么不直接用 `event` / `learning_session` 表达、写路径归谁。

2026-05-20 drift audit §[Plan 2026-05-18] 把此列为 Undocumented finding，建议起草 ADR-0015。

## Decision

追认 `learning_record` + `memory_brief_note` 为一等领域实体，并约束如下。

### 1. `learning_record` — event 链路上的"活动 tag"

**定位**：一次具体学习活动的语义聚合点。Event 是 fine-grained 的不可变 action log（`action='attempt' / 'judge' / 'grade' / ...`）；learning_record 是这些 event 在用户视角上的"一次活动" — 一道题在 attempt + judge + grade 三个 event 后聚合出一行 learning_record。

**与 `event` 的关系**：
- learning_record **从 event 派生**，不替代 event。
- 每行 learning_record 至少挂 1 个 event（`origin_event_id` 必填语义；schema 层 nullable 仅为兼容老回填，新写入路径必须填）。`attempt_event_id` 用于 attempt-kind 的 record，方便走 chained judge / grade event 拼装。
- learning_record 是**可写更新**的（有 `version` + `updated_at` + `processing_status` 字段，从 `raw` → 后续状态流转），event 是**不可变**的。这是核心边界 — 不要把可变更字段塞回 event。

**与 `learning_session` 的关系**：
- learning_session 是时间窗信封（ADR-0008）；session 中一次次活动产生一连串 learning_record。
- learning_record 通过 event 间接挂到 session（`event.session_id`），不直接持 `session_id` —— 这样在没有 session 的场景（独立练习 / 后台批处理）也能存在。

**单一所有者**（ADR-0005 对齐）：
- 写路径：`src/server/records/queries.ts`。所有 insert / update / archive 必须经过此模块导出的 `createLearningRecord()`、`updateLearningRecord()`、`transitionLearningRecord(s)()`、`archiveLearningRecord()`。
- 其它模块（route handler / orchestrator / cron）一律只读，不绕过 queries 模块直接写。
- `tests/integration/step9-invariant-audit.test.ts` 机械扫描生产源码；任何模块外的 `insert/update/delete(learning_record)` 直接让 CI 失败。schema-level enforcement（RLS / trigger）仍可作为以后单独评估项。

**不变量**：
- `kind` ∈ ActivityKind enum（attempt / read / teach_turn / ... 见 `src/core/schema/activity.ts`）。
- `subject_id` 必填语义（与 `event.subject_id` 对齐 / fallback 'wenyan'）。
- `processing_status` 只按下述 mutation contract v1 流转；不得由调用方自造状态边。

#### Mutation contract v1（YUK-740，2026-07-31）

本节是 `learning_record` 可变行的版本化写契约；修改 writer boundary、CAS 或状态图必须显式升版并同步测试。

**CAS**：

- `version` 是唯一 compare-and-swap 轴。调用方提交其读到的版本；每次实际 mutation 恰好 `+1`。
- `updateLearningRecord()` 是严格 CAS：版本不匹配固定返回 409，不得覆盖新行。
- `transitionLearningRecord()` 对「相同目标状态」的重复提交幂等：即使重试携带旧版本，也返回当前行且不再加版本；旧版本若指向不同目标则固定 409。
- 批量状态 helper 先读当前版本，再逐行走同一个 transition primitive；CAS 竞态时重读，已离开来源状态或已到目标状态则跳过，仍可迁移时只做一次 bounded retry。这样 best-effort 批处理不会把已提交 proposal 伪装成整体失败，并发不同写也不会静默覆盖；严格单行 API 的 stale 409 语义不变。

**合法状态图**：

    raw ───────→ linked ───────→ actioned
     │             ↑                │
     ├─────────────┴────────────────┘  raw → actioned 仅保留给 legacy/repair accept
     │                              │
     └──────────→ archived ←────────┘  raw/linked/actioned 均可归档

    actioned → linked                  仅用于 proposal retract；保留「仍曾被引用」信号
    archived → (none)                 terminal；同目标重复归档仅幂等 no-op

正常 runtime 创建从 `raw` 开始；import/replay 可按历史快照创建任一已知状态，这不算状态迁移，且 `archived` 快照必须同时设置 `archived_at`。本 v1 不改 schema、不重写历史行，也不改变读取/导出形状。

**可观测拒绝**：stale version、非法状态边、未知当前状态和 archived 后写入均先发结构化 `[learning-record] mutation_rejected` 日志，再以 409 fail closed。

### 2. `memory_brief_note` — 滚动学习记忆摘要（Dreaming-owned，写路径由 ADR-0017 接管）

**定位**：用户在某个 scope（`scope_key`，例：`subject:math` / `topic:幂运算`）下的"最近学了什么、卡在哪、长期沉淀什么"的三段窗口短文。供 ReviewIntentTask / SessionSummaryTask / TeachingTurnTask 等下游任务读作为上下文。**不接收用户直接输入** — 完全由 Dreaming agent 派生。

**与 `event` / `learning_record` 的关系**：
- 纯派生。Dreaming agent 扫 event 表 + learning_record 表（按 `subject_id` / `scope_key` 过滤），聚合成三段 markdown + 引用 evidence ids（`recent_week_evidence_ids` 等指向 event / learning_record id）。
- 用户操作只产 event；event 触发 Dreaming 重算 brief。
- brief 不是 event 链上的节点，也不参与 attempt / judge / grade 流程。

**唯一性**：每个 `scope_key` **至多一行**（`memory_brief_note_scope_key_unique` 唯一索引）。Dreaming 重算时 upsert，不堆历史版本（`refreshed_at` 标记最新刷新时间；历史 brief 不保留）。

**单一所有者（forward-locking）**：
- ⚠️ 当前 codebase 中 **memory_brief_note 没有任何写路径**（仅在 `src/server/export/constants.ts` 引用为 export 表列表）。**写入器由 ADR-0017 接管落地**（YUK-37 Phase B 实施段）。
- 本 ADR 锁定决策：**memory_brief_note 的所有写路径必须归一个 Dreaming-owned 模块**。**实际代码位置由 ADR-0017 修订为 `src/server/memory/brief.ts`**（原文 `src/server/dreaming/brief.ts` 已 superseded by ADR-0017，timing "Phase 2C" 改为 "Phase B per YUK-37"）。
- 在该写入器落地前：禁止任何模块（route handler / orchestrator / cron / migration）直接 insert / update memory_brief_note。如有临时回填需求，必须先开 ADR-0015 revise 讨论。
- ADR-0017 落地不需要再 revise 本 §2（决策不变），仅把"待定写路径"具体化到 `src/server/memory/brief.ts`。

### 3. 四张主表的关系图

```
event (ADR-0006 v2)      — 不可变 action log，所有持久化必经
  │
  ├─ session_id ────→ learning_session (ADR-0008)
  │                     时间窗信封 / 多类型 sub_kind
  │
  ├─ id ─────────────→ learning_record (ADR-0015 §1)
  │  (origin_event_id /  事件链上的活动 tag / 可变 processing_status
  │   attempt_event_id)
  │
  └─ (派生 evidence) ─→ memory_brief_note (ADR-0015 §2 / ADR-0017)
                        Dreaming 重算 / 唯一 scope_key / 写路径 src/server/memory/brief.ts
```

## Consequences

- ✅ ADR 序列补齐：未来 Agent / 新人通过 ADR-0006 v2 → 0008 → 0014 → 0015 完整理解四张主表。
- ✅ `learning_record` 单一所有者明文约束到 `src/server/records/queries.ts`，并由静态 invariant audit 持续执行，与 ADR-0005 一致。
- ✅ `memory_brief_note` 在 Dreaming agent 落地前显式禁止其它模块写 — 避免临时回填污染语义。
- ✅ `memory_brief_note` 写路径**已由 ADR-0017 接管**（归一 `src/server/memory/brief.ts`，per ADR-0017 Phase B / YUK-37）。本 ADR 的 forward-locking decision 仍生效；Dreaming 设计若大改（例如改为按 event 实时增量而非周期重算），需同步 revise §2 的"周期重算 / upsert 不留历史"约束 + ADR-0017。
- ✅ mutation contract v1 统一 CAS、重复重试和合法状态图；读取/schema 不变，历史 replay/export 保持兼容。
- ⚠️ 当前没有 DB trigger / RLS；跨模块旁路由 CI 静态审计阻止。是否还需数据库级保护留作独立评估，不在本次最小修复内。

## Notes

- 本 ADR 是 Plan 2026-05-18 决策的追认（drift audit 2026-05-20 §[Plan 2026-05-18] finding 推动），不引入新设计。
- learning_record schema 字段细节见 `src/db/schema.ts:223-255`；查询 API 见 `src/server/records/queries.ts`。
- ADR-0014 的 ActivityKind / CapabilityRef registry 是 learning_record `kind` / `payload` 的契约源 — 添加新 kind 走 ADR-0014 流程，不在本 ADR 范围。
