# Phase 1c.1 Implementation Plan — event 核 + learning_session + mesh + UI 脚手架

> ⚠️ **REFRESH 2026-05-16 — Step 3-9 body 重写 + Lane 结构 + ADR-0011 v2 + v2.1 design 落定**
>
> 之前 Step 3-9 body 仍把 entity 当 `encounter`（单表）写，与 ADR-0006 v2（event-stream）不一致 — 本轮 refresh 把 body 与 banner 对齐。`encounter` 一词从 plan body 全部撤回；用户面"错题"概念保留为 `events WHERE action='attempt' AND outcome='failure'` 视图。
>
> **新增**：
> - **Lane 结构**（见下节）：Step 1 / 2 / 10-C1 三 lane 并行；Step 3-9 sequential 在主 lane 上跑
> - **Lane C 切 C1（1c.1）+ C2（1c.2）**：v2.1 设计的 4 个 mesh / tool-use Primitives 依赖 Lane A/B schema 落定，推 1c.2
> - **ADR-0011 v2**（2026-05-16）：`accept_suggestion.payload.suggestion_kind = 'proactive' | 'corrective'` discriminator —— 落进 Step 2 KnownEvent 测试用例
> - **Step 9 修正**：DROP 不含 `artifact`（per ADR-0006 v2，artifact 激活为 C 档 AI 产出落点）
> - **v2.1 设计 promoted**：`docs/design/loom-design-v2.1/` 现在是 canonical 设计源（tokens.css + Primitives.jsx + 6 路由 + Copilot drawer）
>
> ---
>
> ⚠️ **REFRESH 2026-05-15 晚 — ADR-0011 + ADR-0012 追加**
>
> 本 plan 经过 3 轮 ADR 加固，banner 现在含全部 deltas：
>
> **ADR-0006 v2** (2026-05-15)：3-table event-driven 核（material + learning_session + event），DROP mistake / review_event / dreaming_proposal
>
> **ADR-0010** (2026-05-15)：knowledge_edge 表 + 5 个 relation_type（tree 是骨架，mesh 是肌肉）
>
> **ADR-0011** (2026-05-15 晚)：5 个新 event 路径追认 Zod schema：
> - `ToolUseExperimental` (action='experimental:tool_use', subject_kind='query')
> - `AcceptSuggestionChip` (action='accept_suggestion', subject_kind='chip')
> - `ProposeKnowledgeEdge` / `GenerateKnowledgeEdge` / `RateKnowledgeEdge`
>
> **ADR-0012** (2026-05-15 晚)：mastery / last_active_at 转 derived view。**Step 1 同步执行 DROP** 三个 stub 字段（`knowledge.base_mastery` / `ai_delta_mastery` / `last_active_at`）+ 建 `knowledge_mastery` PG view
>
> **deltas 落进 Step**：
> - **Step 1**：event 表 + material_fsrs_state 投影 + **knowledge_edge** + **DROP 三个 stub 字段** + **CREATE VIEW knowledge_mastery** + jsonb GIN index on event.payload（per data-assumptions follow-up）+ **DROP judgment 表**（合并进 event action='judge'）
> - **Step 2**：per-(action × subject_kind) Zod discriminated union——ADR-0006 v2 原 7 个 + ADR-0011 新 5 个 = 共 12 个 KnownEvent + 1 个 ExperimentalEvent (tool_use)
> - **Step 3**：三表 → event 迁移；judgment 表数据若有则同步（应当为空——本来就是死表）
> - **Step 5**：`IngestionSession` 模块演化为 `LearningSession`，写入路径含 event 写
> - **Step 7**：新增 `/api/knowledge/edges` CRUD + KnowledgeProposeTask / KnowledgeReviewTask prompt 扩"propose new edge"分支
> - **Step 8**：mastery view 上线后跑 smoke：query 一个无练习节点应得 NULL，有练习节点 mastery ∈ [0, 1]
> - `artifact` 表**不再 DROP**（C 档 AI 主动产出激活）
>
> 工时调整：10-14d → 20-27d (mesh + ADR-0011/0012 deltas)
>
> Server rename + API rename + UI 脚手架（Step 6-12）大致不变，但 entity 名是 event 而非 encounter。
>
> **Status**: ready for execution（Step 1 已 refresh，Step 2-13 执行时跟随 ADR-0011/0012）
>
> **For agentic workers**：开干前 (a) 补 TDD substeps（参考 sub-0c plan 的 X.1 red / X.3 green / X.5 commit 模式）(b) **必须**先确认 Sub 0c 已 merge 到 main（✅ commit 054837c）(c) 读 ADR-0006 v2 / 0010 / 0011 / 0012 + 数据假设清单 / loom design v2 + v2.1 brief 全部完文 (d) 起 worktree

**Goal**：把 Phase 1c 的核心实体（`event` + `learning_session` + `knowledge_edge` mesh）一次性落地——schema、数据迁移、server read-path 重写、模块演化、API body 重写、AI prompts、测试，外加 UI 脚手架 C1（让 1c.2 五页 + 4 个 mesh/tool-use Primitives 有家可回）。Phase 1c.1 收尾时：mistake / review_event / dreaming_proposal / ingestion_session 四张表 DROP，artifact 激活为 C 档落点，新 schema 长成，UI 框架可见 health 页面。

**Spec**：`docs/superpowers/specs/2026-05-14-phase1c-design.md` + addendum `docs/superpowers/specs/2026-05-15-phase1c-loom-design-addendum.md`

**ADRs**：
- ADR-0006 v2（event 核 — AI 与用户结构对等）
- ADR-0007（单用户假设）
- ADR-0008（LearningSession 多态 envelope）
- ADR-0010（knowledge_mesh — tree + edge）
- ADR-0011 v2（tool_use + accept_suggestion + edge events; suggestion_kind discriminator）
- ADR-0012（mastery → derived view）
- 演化 ADR-0005（IngestionSession single-owner → LearningSession single-owner）

**前置（不可妥协）**：Sub 0c 完全 merge 到 main。`git log main --oneline` 含 sub-0c 收尾 commit；CI 绿。

**预估**：单线 20-27 d；按下面 Lane 结构并行后 9-12 d。

---

## Lane 结构（2026-05-16 加）

并行 3 lane + 主 lane sequential：

```
                    ┌─ Lane A (worktree-A) ─ Step 1 schema / migration / view ─┐
Step 0 (main) ──────┼─ Lane B (worktree-B) ─ Step 2 Zod / event union ─────────┼─→ converge ─→ Step 3 → 4 → 5 → 6 → 7 → 8 → 9 → 11 → 12 → 13
                    └─ Lane C1 (worktree-C) ─ Step 10 UI scaffold (C1 scope) ──┘
```

**Lane 共享契约**（开干前锁，主 lane 写入 spec addendum）：
- `event` 表 schema（Lane A 落 DDL，Lane B 读 columns）
- `action` enum 11 个 KnownEvent + `experimental:*`（Lane B 落 Zod，Lane A index 用）
- `subject_kind` enum 8 个（同上）

**Lane 间 dependency**：
- Lane B 引用 Lane A 的表名 / 列名，但只在测试 fixture（Zod parse 不依赖 drizzle types）— **可同时跑**
- Lane C1 用 v2.1 设计的 tokens.css + Primitives.jsx，**完全独立** schema —— 可同时跑

**Lane C 切 C1（本 1c.1）/ C2（推 1c.2）**：

| Lane C1（Step 10，本 plan） | Lane C2（推 1c.2）|
|---|---|
| Tailwind v4 setup · tokens.css lift · Source Serif 4 / Noto Serif SC / JetBrains Mono CDN | mesh / tool-use Primitives（依赖 Lane A schema） |
| v1+v2 通用 10 个 Primitives port：Brand / Icon / Button / Badge / StatusBadge / CauseBadge / Card / PageHeader / TopNav / TabBar | `<ToolUseCard>` · `<KnowledgeRelation>` · `<EdgeProposalCard>` · `<KnowledgeGraph>`（手写 SVG verlet） |
| `/health` 烟测页 + TanStack Query + Zustand provider | Copilot drawer 三段式 |
| 2-3d | 3-4d 并到 1c.2 第一步 |

---

## Step 0: 准备 + 工作树 + 依赖

- 检查 `git status` 干净；从 main 起新分支 `phase1c1-implementation`
- 起 worktree（参考 superpowers `using-git-worktrees` skill）
- `pnpm install` 干净，无新依赖（理论上）
- 启 `pnpm db:push` against testcontainer 验证起手 schema 与 main 一致
- Commit 占位：分支创建 + worktree 配置

---

## Step 1: 新 schema — event 核 + learning_session + mesh + DROP stub 字段 + 建 view

> 本 Step 是 1c.1 灵魂——schema 一次性全到位。后续 Step 2-13 都建立在它之上。

### Step 1.1: 新增 `event` + `learning_session` + `material_fsrs_state` + `knowledge_edge` 表（DDL only，**不动**旧表）

在 `src/db/schema.ts` 加：

```typescript
export const event = pgTable('event', {
  id: text('id').primaryKey(),
  session_id: text('session_id'),                  // nullable — cron / system 事件可空
  actor_kind: text('actor_kind').notNull(),        // 'user' | 'agent' | 'cron' | 'system'
  actor_ref: text('actor_ref').notNull(),          // 'self' | task_kind | cron_name
  action: text('action').notNull(),                // 'attempt' | 'judge' | 'propose' | 'generate' | 'review' | 'rate' | 'extract' | 'accept_suggestion' | 'experimental:*'
  subject_kind: text('subject_kind').notNull(),    // 'question' | 'knowledge' | 'knowledge_edge' | 'artifact' | 'source_document' | 'event' | 'chip' | 'query'
  subject_id: text('subject_id').notNull(),
  outcome: text('outcome'),                        // 'success' | 'failure' | 'partial' | NULL
  payload: jsonb('payload').notNull(),             // Zod-guarded（per ADR-0006 v2 + 0011）
  caused_by_event_id: text('caused_by_event_id'),  // chain
  task_run_id: text('task_run_id'),
  cost_micro_usd: integer('cost_micro_usd'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('event_subject_idx').on(t.subject_kind, t.subject_id, t.created_at.desc()),
  index('event_action_outcome_idx').on(t.action, t.outcome, t.created_at.desc()),
  index('event_session_idx').on(t.session_id, t.created_at),
  index('event_actor_idx').on(t.actor_kind, t.actor_ref, t.created_at),
  // GIN on payload — per data-assumptions follow-up
  sql`CREATE INDEX event_payload_idx ON event USING GIN (payload jsonb_path_ops)`,
  // caused_by 链
  index('event_caused_by_idx').on(t.caused_by_event_id),
]);

export const learning_session = pgTable('learning_session', {
  id: text('id').primaryKey(),
  type: text('type').notNull(),                    // 'ingestion' | 'review' | 'tutor' | 'explore' | 'create' | 'conversation'
  status: text('status').notNull(),                // per-type 状态机
  source_document_id: text('source_document_id'),  // 仅 type='ingestion'
  source_asset_ids: jsonb('source_asset_ids').$type<string[]>().notNull().default([]),
  entrypoint: text('entrypoint'),                  // 仅 type='ingestion'
  warnings: jsonb('warnings').$type<string[]>().notNull().default([]),
  error_message: text('error_message'),
  summary_md: text('summary_md'),                  // type='conversation' 用
  goal_id: text('goal_id'),                        // 占位 Phase 1d
  started_at: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  ended_at: timestamp('ended_at', { withTimezone: true }),
  version: integer('version').notNull().default(0),
  created_at, updated_at, ...
});

export const material_fsrs_state = pgTable('material_fsrs_state', {
  id: text('id').primaryKey(),                     // synthetic
  subject_kind: text('subject_kind').notNull(),    // 'question'（v1 只支持题；其他 material 后续）
  subject_id: text('subject_id').notNull(),
  state: jsonb('state').$type<FsrsState>().notNull(),
  due_at: timestamp('due_at', { withTimezone: true }).notNull(),
  last_review_event_id: text('last_review_event_id'),   // event.id
  updated_at: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  uniqueIndex('material_fsrs_unique').on(t.subject_kind, t.subject_id),
  index('material_fsrs_due_idx').on(t.due_at),
]);

export const knowledge_edge = pgTable('knowledge_edge', {
  id: text('id').primaryKey(),
  from_knowledge_id: text('from_knowledge_id').notNull().references(() => knowledge.id),
  to_knowledge_id: text('to_knowledge_id').notNull().references(() => knowledge.id),
  relation_type: text('relation_type').notNull(),     // ADR-0010 5+experimental
  weight: real('weight').notNull().default(1),
  created_by: jsonb('created_by').$type<{actor_kind: string, actor_ref?: string}>().notNull(),
  reasoning: text('reasoning'),
  created_at: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  archived_at: timestamp('archived_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('knowledge_edge_unique').on(t.from_knowledge_id, t.to_knowledge_id, t.relation_type),
  index('knowledge_edge_from_idx').on(t.from_knowledge_id, t.relation_type),
  index('knowledge_edge_to_idx').on(t.to_knowledge_id, t.relation_type),
]);
```

### Step 1.2: DROP stub 字段（ADR-0012 同步执行）

```typescript
// schema.ts knowledge 表内删除：
//   base_mastery: real('base_mastery').notNull().default(0),
//   ai_delta_mastery: real('ai_delta_mastery').notNull().default(0),
//   last_active_at: timestamp('last_active_at', { withTimezone: true }),
// 也删 check constraint:
//   check('knowledge_base_mastery_range', sql`${t.base_mastery} BETWEEN 0 AND 1`),
//   check('knowledge_ai_delta_mastery_range', sql`${t.ai_delta_mastery} BETWEEN -0.2 AND 0.2`),
```

drizzle-kit 出 migration with `ALTER TABLE knowledge DROP COLUMN ...`。

### Step 1.3: CREATE VIEW `knowledge_mastery`（ADR-0012）

drizzle 不直接支持 view，**手写 SQL migration**：

```sql
-- migrations/00XX_create_knowledge_mastery_view.sql

CREATE VIEW knowledge_mastery AS
WITH attempts AS (
  SELECT
    k.id AS knowledge_id,
    e.id AS event_id,
    e.outcome,
    e.created_at,
    exp(-ln(2) * extract(days from (now() - e.created_at)) / 30.0) AS weight
  FROM knowledge k
  CROSS JOIN LATERAL (
    SELECT id, outcome, created_at, payload
    FROM event
    WHERE action IN ('attempt', 'review')
      AND subject_kind = 'question'
      AND created_at > now() - interval '180 days'
      AND payload->'referenced_knowledge_ids' @> to_jsonb(k.id)
  ) e
),
agg AS (
  SELECT
    knowledge_id,
    sum(CASE WHEN outcome = 'success' THEN weight ELSE 0 END) AS weighted_success,
    sum(weight) AS weighted_total,
    count(*) AS evidence_count,
    max(created_at) AS last_evidence_at
  FROM attempts
  GROUP BY knowledge_id
),
activity AS (
  SELECT
    k.id AS knowledge_id,
    max(e.created_at) AS last_event_at
  FROM knowledge k
  CROSS JOIN LATERAL (
    SELECT created_at
    FROM event
    WHERE (subject_kind = 'knowledge' AND subject_id = k.id)
       OR (payload->'referenced_knowledge_ids' @> to_jsonb(k.id))
       OR (payload->'knowledge_ids' @> to_jsonb(k.id))
  ) e
  GROUP BY k.id
)
SELECT
  k.id AS knowledge_id,
  CASE
    WHEN agg.evidence_count IS NULL OR agg.evidence_count = 0 THEN NULL
    WHEN agg.evidence_count < 3 THEN 0.5
    ELSE (agg.weighted_success / agg.weighted_total)::real
  END AS mastery,
  coalesce(agg.evidence_count, 0) AS evidence_count,
  agg.last_evidence_at,
  coalesce(activity.last_event_at, k.created_at) AS last_active_at
FROM knowledge k
LEFT JOIN agg ON agg.knowledge_id = k.id
LEFT JOIN activity ON activity.knowledge_id = k.id;
```

drizzle 侧把这个 view 当只读表注册：

```typescript
export const knowledge_mastery = pgView('knowledge_mastery', {
  knowledge_id: text('knowledge_id').notNull(),
  mastery: real('mastery'),                  // nullable: 未练习
  evidence_count: integer('evidence_count').notNull(),
  last_evidence_at: timestamp('last_evidence_at', { withTimezone: true }),
  last_active_at: timestamp('last_active_at', { withTimezone: true }).notNull(),
}).existing();
```

### Step 1.4: DROP judgment 表（data-assumptions §O2 决策）

audit follow-up 验证 `judgment` 表 ADR-0006 v2 后判分走 `event(action='judge')` 替代——judgment 表无家可归，**1c.1 一起 DROP**：

```typescript
// schema.ts：删除 judgment 表定义
```

drizzle-kit migration 出 `DROP TABLE judgment CASCADE`（依赖：`user_appeal.judgment_id` FK 同步处理；audit 显示 user_appeal 也是空表，**一起 DROP**）。

### Step 1.5: Migration 出 + 测试

`pnpm db:generate` 出 drizzle 自动 migrations + 手挂 `0XXX_knowledge_mastery_view.sql`。

跑 `pnpm db:push` against testcontainer：
- 新表 ✅
- DROP 字段 ✅
- VIEW 建好 ✅
- DROP 死表 ✅

`pnpm test` 期望全绿（schema 改动不破坏现有测试，因为 mistake / ingestion_session / artifact 还在；mastery 字段读路径 audit 已确认无）。

Commit：`feat(1c.1): Step 1 schema — event + mesh + DROP stub fields + knowledge_mastery view + DROP judgment`

---

## Step 2: per-(action × subject_kind) Zod discriminated union + learning_session schemas

> 本 Step 落地 ADR-0006 v2 + ADR-0010 + ADR-0011 = **12 个 KnownEvent + 1 个 ExperimentalEvent**。Option 折中：核心严守 Zod discriminated union；experimental:* 命名空间松守。

### Step 2.1: 共用 building blocks

`src/core/schema/event/blocks.ts`：

- `ActorKind` enum: `'user' | 'agent' | 'cron' | 'system'`
- `SubjectKind` enum: `'question' | 'knowledge' | 'knowledge_edge' | 'artifact' | 'source_document' | 'event' | 'chip' | 'query'`
- `MaterialRef` polymorphic Zod schema（kind discriminant）—— 用于 payload 内引用 question / knowledge / artifact
- `CauseSchema`（ADR-0006 v2 原 10 类 enum + analysis_md + confidence）
- `FsrsStateSchema`（ts-fsrs 状态 dump，jsonb roundtrip 安全）
- `RelationTypeSchema`（ADR-0010 5 + `experimental:*`）

### Step 2.2: KnownEvent discriminated union（12 个分支）

`src/core/schema/event/known.ts`：

**ADR-0006 v2 原 7 个**：
1. `AttemptOnQuestion` — `actor=user|agent / action='attempt' / subject='question'`
2. `JudgeOnEvent` — `actor=agent / action='judge' / subject='event'`，payload.cause
3. `ReviewOnQuestion` — `actor=user / action='review' / subject='question'`，payload.fsrs_*
4. `ProposeKnowledge` — `actor=agent / action='propose' / subject='knowledge'`
5. `GenerateArtifact` — `actor=agent / action='generate' / subject='artifact'`
6. `RateEvent` — `actor=user / action='rate' / subject='event'`
7. `ExtractSourceDocument` — `actor=agent / action='extract' / subject='source_document'`

**ADR-0011 新 4 个**：
8. `AcceptSuggestionChip` — `actor=user / action='accept_suggestion' / subject='chip'`，payload.{chip_label, target_tool, target_args, source_event_id}
9. `ProposeKnowledgeEdge` — `actor=agent / action='propose' / subject='knowledge_edge'`，payload.{from, to, relation_type, weight, reasoning}
10. `GenerateKnowledgeEdge` — `actor=agent|user / action='generate' / subject='knowledge_edge'`，payload + optional propose_event_id
11. `RateKnowledgeEdge` — `actor=user / action='rate' / subject='knowledge_edge'`，payload.rating ∈ {accept, dismiss, reverse, change_type, rollback}

**ADR-0010 已规定但是 ADR-0011 给 Zod**：
（上面 9/10/11 即 ADR-0010 三个 edge events）

```ts
export const KnownEvent = z.discriminatedUnion('action', [
  AttemptOnQuestion,
  JudgeOnEvent,
  ReviewOnQuestion,
  ProposeKnowledge,
  ProposeKnowledgeEdge,
  GenerateArtifact,
  GenerateKnowledgeEdge,
  RateEvent,
  RateKnowledgeEdge,
  AcceptSuggestionChip,
  ExtractSourceDocument,
]);
```

注意：discriminatedUnion 只支持单键判别（action），但每个分支用 `z.literal()` 也固化了 subject_kind，因此组合 (action, subject_kind) 单义。

### Step 2.3: ExperimentalEvent escape hatch

`src/core/schema/event/experimental.ts`：

```ts
export const ExperimentalEvent = z.object({
  action: z.string().refine((s) => s.startsWith('experimental:')),
  payload: z.record(z.string(), z.unknown()),
});
```

**特化 ToolUseExperimental**（per ADR-0011 §1）：

```ts
export const ToolUseExperimental = z.object({
  actor_kind: z.literal('agent'),
  actor_ref: z.string(),
  action: z.literal('experimental:tool_use'),
  subject_kind: z.literal('query'),
  outcome: z.enum(['success', 'failure']),
  payload: z.object({
    tool_name: z.string(),
    args: z.record(z.string(), z.unknown()),
    result_summary: z.string().optional(),
    result_count: z.number().int().optional(),
    error_reason: z.string().optional(),
  }),
});
```

它形式上是 ExperimentalEvent 的特例；parse 时先试 ToolUseExperimental，失败回退通用 ExperimentalEvent。

### Step 2.4: Event 顶层 union + parse helper

`src/core/schema/event/index.ts`：

```ts
export const Event = z.union([KnownEvent, ToolUseExperimental, ExperimentalEvent]);
export type EventT = z.infer<typeof Event>;
export const parseEvent = (input: unknown) => Event.parse(input);
```

### Step 2.5: learning_session per-type schemas

`src/core/schema/learning_session.ts`：

- `LearningSessionType` enum: `'ingestion' | 'review' | 'tutor' | 'explore' | 'create' | 'conversation'`
- per-type 状态机：
  - `ingestion`: `uploaded → queued → extracting → extracted | partial | failed → reviewed → imported`（沿用 ADR-0005）
  - `review`: `started → completed | abandoned`
  - `conversation`: `active → idle → ended`（ADR-0008）
  - `tutor` / `explore` / `create`: 占位（Phase 1d/2 落定）
- `LearningSessionStatusByType` discriminated union 按 type 判别

### Step 2.6: 测试

`tests/schema/event.test.ts`：

每个 KnownEvent 分支至少 1 个 valid + 1 个 invalid parse 用例。重点：
- 非法组合（action='attempt' 配 subject='knowledge_edge' 等）必须拒绝
- experimental:* prefix 不在 KnownEvent action 范围内（防漂移）
- ProposeKnowledgeEdge.payload.relation_type 是 ADR-0010 5 个 enum 或 `experimental:*`，不是任意字符串
- AcceptSuggestionChip.payload.target_tool 与 source_event_id 都是字符串
- ToolUseExperimental.payload.args 接受任意 record

Commit：`feat(1c.1): Step 2 — Event Zod discriminated union (12 known + experimental escape) + learning_session per-type`

---

## Step 3: 数据迁移脚本（三表 → event，ingestion_session → learning_session）

写 `scripts/migrate-phase1c1.ts`（参考 Sub 5 export/import 风格）：

**三表 → event**（ADR-0006 v2 §"DROP 三张表"）：

- 读 `mistake` 全表 → 每行映射为 1-2 个 event：
  - `event(actor_kind='user', action='attempt', subject_kind='question', subject_id=question_id, outcome='failure', payload={user_answer_md, user_answer_image_refs, knowledge_ids})`
  - 若 `mistake.cause IS NOT NULL`：再写一个 `event(actor_kind='agent', actor_ref='legacy_attribution', action='judge', subject_kind='event', subject_id=<attempt_event.id>, payload={cause, analysis_md, confidence}, caused_by_event_id=<attempt_event.id>)`
- 读 `review_event` 全表（若有数据） → `event(actor_kind='user', action='review', subject_kind='question', subject_id=question_id, payload={rating, fsrs_state_before, fsrs_state_after}, outcome='success')`
  - 同时把最新一条 review_event 的 fsrs_state_after 投影进 `material_fsrs_state(subject_kind='question', subject_id=question_id, state, due_at, last_review_event_id)`
- 读 `dreaming_proposal` 全表（若有数据） → `event(actor_kind='agent', actor_ref='dreaming', action='propose', subject_kind='knowledge', payload={proposed_knowledge, parent_id, reasoning})`
- 读 `judgment` 全表（per banner，应为空） → `event(actor='agent', action='judge', subject_kind='event', ...)` 占位逻辑（实际跑应跳过）

**ingestion_session → learning_session**：

- 每行映射：`type='ingestion'`、`status` 平移、其他 ingestion-specific 列对齐 → INSERT 进 `learning_session`
- session_id 保留作 event.session_id 外键候选（attempt event 若来自 ingestion 期间的复习记录，链 caused_by 上去）

**未做**：DROP 旧表（留给 Step 9）。脚本幂等：每个写都加 ON CONFLICT DO NOTHING 或先 SELECT 检查。

测试 `scripts/migrate-phase1c1.test.ts`：建 fixture（mistake + review_event + ingestion_session）→ 跑 migration → 验证：
- event 表行数 = mistake 数 + 有 cause 的 mistake 数 + review_event 数 + dreaming_proposal 数
- learning_session 行数 = ingestion_session 行数
- material_fsrs_state 只对有过 review_event 的 question 有行
- 旧表数据不变（only-additive 迁移）

Commit：`feat(1c.1): data migration script — mistake/review_event/dreaming_proposal/ingestion_session → event/learning_session`

---

## Step 4: Server 端 read-path 重写 — mistake → event stream

**不是机械 rename**。`mistake` 是单表实体；`event` 是 action log。同一份"错题数据"在新模型下是 1-2 个 events 的 view（attempt + optional judge）。所以 server code 要换查询模式：

| 旧 | 新 |
|---|---|
| `db.select().from(mistake).where(eq(mistake.id, ...))` | `db.select().from(event).where(and(eq(event.action,'attempt'), eq(event.subject_kind,'question'), eq(event.outcome,'failure'), ...))` + LATERAL JOIN judge event |
| `db.insert(mistake).values({...})` | `db.insert(event).values({action:'attempt', subject_kind:'question', outcome:'failure', payload:{user_answer,...}})` + 触发 attribution 写 `event(action='judge', subject_kind='event', caused_by=...)` |
| `mistake.cause` 直接读字段 | 沿 `caused_by` 链找到对应 judge event，读 `payload.cause` |

**重写文件**：

- `src/server/knowledge/attribute.ts`：写 attempt + judge 两个 event；不再写 mistake 表
- `src/server/knowledge/propose.ts`：read 错题列表 = `event(action='attempt', outcome='failure')` 流；query knowledge_ids 走 event.payload jsonb GIN
- `src/server/knowledge/review.ts`：query "近期错题" = event filter（保留同一函数签名 — 内部换实现）
- `src/server/export/csv.ts`：rebuild 错题导出 = 按 attempt event + 关联 judge event reduce 成原 mistake-shape CSV 行（向前兼容老 CSV reader）
- 所有 `import { mistake } from '@/db/schema'` → 删；改 `import { event } from '@/db/schema'`
- 业务层封装：新建 `src/server/events/queries.ts` 提供 `getFailureAttempts(filter)` / `getJudgeFor(eventId)` 等 helper，让上层不写裸 event SQL（per ADR-0005 single-owner 风格 — event 表只有 events module 写）

**测试**：

- `tests/integration/mistake-readpath.test.ts`：fixture 写 attempt + judge events → 跑老 mistake-shape 查询 helper → 验证返回与历史 mistake table 一致
- 全栈 `grep -r "from.*mistake\b\|import.*mistake\b" src/ app/` 期望仅在 `scripts/migrate-phase1c1.ts` 和 `tests/migration/` fixture 中出现（迁移期暂留）

`pnpm test` 全绿；`pnpm typecheck` 全绿。

**注意**：本步**写代码用 event 表**，但**老 mistake 表仍未删**（Step 9 删）。中间态：旧 mistake 数据靠 Step 8 迁移到 event 表，server code 全部读新表。

Commit（可分 3 sub-commit，按文件域）：
- `refactor(1c.1): events queries module (read-path helpers)`
- `refactor(1c.1): attribute/propose/review server — write events instead of mistake`
- `refactor(1c.1): export csv rebuild from event stream (back-compat)`

---

## Step 5: IngestionSession 模块演化 → `src/server/session/`

> 这是本 plan 最复杂的一步。参考 ADR-0008 的演化路径。

- 新建 `src/server/session/index.ts` —— 多态入口
- 新建 `src/server/session/ingestion.ts` —— 把 `src/server/ingestion/session.ts` 的实现搬过来，命名空间改为 `LearningSession.Ingestion.*`
- 新建 `src/server/session/review.ts` —— 最小状态机：`started → completed | abandoned`
- 删 `src/server/ingestion/session.ts`（搬空了）
- 所有调用方（OCR handler / rescue / import route / extract route）改 import `from '@/server/session'`
- API 命名保留 `/api/ingestion/*` 不动（语义本身没变），但内部写 `learning_session(type='ingestion')`
- **event 写入路径**：所有 session 状态转移同时写一个 `event(actor_kind='system' | 'user', action='extract' | 'review' | ..., subject_kind='source_document' | 'event', session_id=<learning_session.id>)`（per banner "Step 5: LearningSession，写入路径含 event 写"）
- 单一所有者 invariant verify：grep `db.update(learning_session)` 在模块外应 zero hit；grep `db.insert(event)` 在 module 外（除 attribution / review handler 外）应 zero hit

`pnpm test` 全绿。

Commit：`refactor(1c.1): IngestionSession → LearningSession multi-type module (ADR-0005 evolved by ADR-0008)`

---

## Step 6: API routes 重写 — `/api/mistakes` 保 URL，body 走 event 流

**URL 不改**（用户面"错题"概念稳定）；body 内部换实现：

- `app/api/mistakes/route.ts` GET：返回 events filter → 投影到 mistake-shape JSON（用 Step 4 的 `getFailureAttempts` helper）
- `app/api/mistakes/recent/route.ts` GET：同上，加 ORDER BY created_at DESC + LIMIT
- `app/api/mistakes/route.ts` POST：client 送 `{question_id, user_answer, knowledge_ids, cause?}`；内部写 attempt event +（若给 cause）judge event
- 新增 `app/api/events/route.ts`：原生 event log API（GET filter by action/subject_kind/actor）+ `app/api/events/[id]/route.ts` GET 单 event + caused_by chain（v2.1 设计 EventChain primitives 需要）
- 新增 `app/api/knowledge/edges/route.ts` GET / POST（per banner "Step 7 新增 /api/knowledge/edges CRUD"——这块挪到 Step 6 一起 batch）
- 所有 route test 加 event-shape 测试 + 老 mistake-shape JSON contract 保持测试

Commit（可分 2 sub-commit）：
- `feat(1c.1): /api/events + /api/knowledge/edges raw event APIs`
- `refactor(1c.1): /api/mistakes — body re-implemented over event stream (URL stable)`

---

## Step 7: AI prompts + registry 更新

- `src/ai/registry.ts` 各 task system prompt：
  - "错题" 在用户面文案**保留**（用户语义稳定）
  - 模型可见的 entity 命名：从 "mistake record" 改为 "attempt event (action=attempt, outcome=failure) 及其关联 judge event"
  - AttributionTask: input = `event(action='attempt', outcome='failure')` + question 上下文；output = `event(action='judge', subject_kind='event', payload.cause)` —— prompt 描述这条 chain
  - KnowledgeReviewTask: tree snapshot + recent failure attempts (filter `events WHERE action='attempt' AND outcome='failure' AND created_at > now()-7d`) + **新增**："propose new knowledge_edge" 分支（per banner Step 7 delta + ADR-0010）
  - KnowledgeProposeTask: 同上，prompt 扩"在 propose knowledge 节点之外，也可 propose knowledge_edge (relation_type, from, to, reasoning)"
  - 其他 task 同理
- 测试：AI runner 自测（registry parse + runTask 仍工作）+ 新 KnowledgeReviewTask 输出能 parse 进 `ProposeKnowledgeEdge` schema（Step 2 落地）

Commit：`refactor(1c.1): AI prompts + registry — entity = event stream + edge propose branch`

---

## Step 8: 跑数据迁移 + mastery view smoke

> 严格按顺序：**Step 1-7 已 merge** → 老 mistake/review_event/dreaming_proposal/ingestion_session 数据 + 新 event/learning_session 空表共存 → 跑迁移。

- Production（NAS）维护窗：手动 `pnpm tsx scripts/migrate-phase1c1.ts` 跑一次
- Dev：写 `tests/global-setup.ts` 钩子，testcontainer 初次 `db:push` 后自动跑（**幂等**：如果 event 表已有从 mistake 转的数据则跳过）
- 整合后跑全套测试，**期望全绿**
- **Mastery view smoke**（per banner Step 8 delta）：
  - `SELECT * FROM knowledge_mastery WHERE knowledge_id = '<某未练习节点>'` → `mastery IS NULL`
  - `SELECT * FROM knowledge_mastery WHERE knowledge_id = '<刚迁移过的有 ≥3 failure attempt 的节点>'` → `mastery BETWEEN 0 AND 1` 且 `evidence_count >= 3`
  - 加进 `tests/integration/mastery-view.test.ts`

Commit：`feat(1c.1): execute data migration in test setup + mastery view smoke`

---

## Step 9: DROP 旧表 — mistake / review_event / dreaming_proposal / ingestion_session

> 不可逆点。本步**之前**所有代码必须已切到 event/learning_session。

**DROP 范围**（per ADR-0006 v2 + banner 修正）：

- `mistake` — 数据已迁 event(action='attempt', outcome='failure')
- `review_event` — 数据已迁 event(action='review')
- `dreaming_proposal` — 数据已迁 event(action='propose', actor_kind='agent')
- `ingestion_session` — 数据已迁 learning_session(type='ingestion')

**保留**（per ADR-0006 v2）：

- `artifact` — **激活**为 C 档 AI 主动产出落点（generate event 写入；comment update 见 [issue #34 finding 1](https://github.com/Yukoval-Dakia/the-learning-project/issues/34)）
- `learning_item` — TODO/Goal 语义独立
- `cost_ledger` / `tool_call_log` — per-step AI 账本
- `job_events`（Sub 0c）— pg-boss plumbing

**Already DROP in Step 1**：`judgment` + `user_appeal`（data-assumptions §O2）

**操作**：

- Drizzle schema：删除 `mistake` / `review_event` / `dreaming_proposal` / `ingestion_session` 表定义
- `pnpm db:generate` 出 DROP migration
- 同时 `src/core/schema/generated.ts` 重新 generate（生成的 Zod 类型同步消失）
- `src/db/schema.ts:278-280` artifact 表注释更新为 "激活 — C 档 AI 主动产出落点（per ADR-0006 v2）"——关闭 [issue #34 finding 1](https://github.com/Yukoval-Dakia/the-learning-project/issues/34)
- 测试 round-trip：跑测试套件 + 全栈 grep `mistake|review_event|dreaming_proposal|ingestion_session` 在 schema/migration 外应 zero hit；grep `artifact` 应在 `src/server/ai/` 出现（写 generate event）

Commit：`feat(1c.1): DROP 4 legacy tables (mistake/review_event/dreaming_proposal/ingestion_session) — point of no return`

---

## Step 10: UI 脚手架（Lane C1 scope）— Next.js routing + Zustand + TanStack Query + v2.1 tokens

> **2026-05-16 refresh**：v2.1 设计 promoted 到 `docs/design/loom-design-v2.1/`（canonical）。本 Step 只 port 10 个 v1/v2 通用 Primitives（**C1 scope**）；mesh / tool-use 4 个 Primitives 推到 1c.2 Lane C2。

**Lane C1 scope**：

- 替换 `app/page.tsx`：redirect 到 `/today`
- `app/layout.tsx`：globals.css import、TanStack Query Provider、Zustand store provider
- `src/ui/lib/queryClient.ts`：TanStack Query 单例配置
- `src/ui/stores/`：Zustand stores skeleton（先空：session store / event store —— 注意名是 event store，**不**叫 encounter store）
- `app/globals.css`：Tailwind v4 + **直接 lift `docs/design/loom-design-v2.1/tokens.css` 进 `@theme` 块**（warm paper + ink + 单一 coral + FSRS 3 档 + info color；token names 完全沿用 v2.1）
- 字体：v2.1 `tokens.css` 已含 Google Fonts `@import`（Source Serif 4 / Noto Serif SC / Noto Sans SC / JetBrains Mono）—— production 切自托管 MiSans 留 1c.2 处理
- 资源 lift：copy `docs/design/loom-design/project/assets/loom-{monogram,wordmark}.svg` + `icon-{192,512}.png` 到 `public/`（v2.1 没改 logo —— sticking with v1 placeholder per [issue #22](https://github.com/Yukoval-Dakia/the-learning-project/issues/22)）
- `src/ui/primitives/`：port v1/v2 通用 10 个原子到 TSX 文件，从 `docs/design/loom-design-v2.1/primitives.jsx` 抽：
  - `Brand.tsx` / `Icon.tsx`（用 `lucide-react`）
  - `Button.tsx` / `Badge.tsx` / `StatusBadge.tsx` / `CauseBadge.tsx`
  - `Card.tsx` / `PageHeader.tsx` / `TopNav.tsx` / `TabBar.tsx`
- `app/health/page.tsx`：烟测页面，GET `/api/health` 显示 status（用 `<Card>` + `<StatusBadge>` 验证 Primitives 通了）

**Lane C1 不做**（推 Lane C2 / 1c.2）：

- `<ActorBadge>` / `<EventChain>` / `<ProposalCard>` / `<CopilotDrawer>` / `<CostRibbon>` / `<Lane>`（v2 引入，依赖 event/session 数据已落）
- `<KnowledgeRelation>` / `<EdgeProposalCard>` / `<KnowledgeGraph>` / `<ToolUseCard>`（v2.1 引入，依赖 mesh schema 已落）
- 6 路由 + Copilot drawer 的实际页面（1c.2 主菜）

`pnpm dev` 启起来；浏览器访问 `/health` 显示 OK + 视觉用 v2.1 palette 渲染（warm paper + coral focus ring）。

Commit：`feat(1c.1): UI scaffold (C1) — Next.js routing + Zustand + TanStack Query + v2.1 tokens + 10 base Primitives`

---

## Step 11: 烟测 + 验证 invariant

- `pnpm test` 全绿
- `pnpm typecheck` 全绿
- `pnpm lint` 全绿
- `pnpm audit:schema` 全绿（allowlist 中 3 个 mastery stub 字段 entries 应已可删，因为字段已 DROP）
- grep 健康度：
  - `mistake` / `review_event` / `dreaming_proposal` / `ingestion_session` 在 src / app 内零 hit（仅 migration 脚本 + tests/migration fixture 中保留）
  - `db.update(learning_session)` 仅在 `src/server/session/` 出现
  - `db.insert(event)` 在 `src/server/events/` / `src/server/ai/` / `src/server/session/` 之外应 zero hit
  - `artifact` 应在 `src/server/ai/` 出现（C 档 generate 路径）
- 集成测试：跑一次完整 ingestion → import → attempt event 创建 → judge event 创建（attribution）→ review event → material_fsrs_state 更新 → mastery view 反映新分

Commit：`test(1c.1): single-owner invariant verified across event + learning_session + mastery view`

---

## Step 12: docs — architecture.md + CONTEXT.md provisional → final

- `docs/architecture.md`：
  - "录入会话状态机" 章节 → 升级为 "学习会话 (LearningSession) 多态状态机"
  - 加 "event — first-class action log" 章节（user / agent / cron / system 对等）
  - 加 "knowledge_mesh — tree + edge" 章节（per ADR-0010）
  - 删除任何 "mistake 是学习记录核心" 的描述
  - **新增**：追认 `echo_jobs` + `/api/echo` 为 pg-boss dev harness（关闭 [issue #34 finding 2](https://github.com/Yukoval-Dakia/the-learning-project/issues/34)，选项 a）
- `CONTEXT.md`：
  - "已批准" 节去除 "待 Phase 1c.1 落地" 标记
  - 删除 v1 词条注释（已被取代）
  - "错题（mistake）" 旧词条 → 改为 `event(action='attempt', outcome='failure')` 的视图注解
  - "复习（review）" / "归因（attribution）" / "梦境流" / "维护流" 词条同步引用对应 event filter
- `README.md`：如有提到 mistake / encounter 的，同步更新

Commit：`docs(1c.1): architecture.md + CONTEXT.md — event / learning_session / mesh promoted to canonical`

---

## Step 13: PR

```bash
gh pr create --title "Phase 1c.1: event-driven core + learning_session + knowledge mesh + UI scaffold" \
  --body "$(cat <<'EOF'
## Summary
- Phase 1c.1 实现 spec docs/superpowers/specs/2026-05-14-phase1c-design.md
- ADRs: 0006 v2 (event 核) / 0007 (single-user) / 0008 (LearningSession) / 0010 (mesh) / 0011 v2 (tool-use + suggestion paths) / 0012 (mastery view)
- mistake / review_event / dreaming_proposal / ingestion_session 四表 DROP；event + learning_session + knowledge_edge 取代
- artifact 表激活为 C 档 AI 产出落点（保留，不 DROP）
- knowledge.{base_mastery, ai_delta_mastery, last_active_at} 三 stub 字段 DROP；CREATE VIEW knowledge_mastery
- IngestionSession 模块 (ADR-0005) 演化为 LearningSession 多态模块 (ADR-0008)
- UI 脚手架 C1 就位（10 个通用 Primitives + v2.1 tokens），1c.2 主菜 6 路由 + 4 mesh/tool-use Primitives (C2)

## Test plan
- [ ] pnpm test 全绿
- [ ] pnpm typecheck 全绿
- [ ] pnpm audit:schema 全绿
- [ ] grep verify: mistake/review_event/dreaming_proposal/ingestion_session 在 src/app/ 零 hit
- [ ] 集成测试: ingestion → attempt event → judge event → review event → mastery view 全链路
- [ ] pnpm dev + 浏览器 /health 显示 OK + v2.1 palette

Closes: #34

🤖 Generated with Claude Code
EOF
)"
```

---

## Notes / 防踩坑

- **Step 9 是不可逆点**：DROP 之前所有代码必须切干净；建议 Step 9 前在 worktree 内做一次"假装我已经 merge"自测
- **rename touch 面太广不要试图一次 commit**：Step 4 / 6 / 7 各自可拆 2-3 个 sub-commit（按文件域分）便于 review
- **Step 5 模块演化最易出错**：建议在 worktree 内单独建子分支推 Step 5、稳定后 rebase 回主分支
- **测试 fixture 大概 ~15 个文件改**：用 codemod 工具（如 ts-morph）批量处理可省时
- **Phase 1c.2 plan 等本 plan 落定后再细化**：等 1c.1 PR merge 时 UI 脚手架就位，再起 `docs/superpowers/plans/2026-05-XX-phase1c2-ui-main.md`

---

## TBD: TDD 子步细化

本 plan 是 sketch。开干前应：

1. 用 `superpowers:writing-plans` skill 把每个 Step 拆成 X.1 (red test) / X.2 (verify fail) / X.3 (green impl) / X.4 (verify pass) / X.5 (commit) 五子步
2. 标注每个测试文件 path 和测试名
3. 跑一次"用 plan 落地"演练（在 disposable worktree 上）评估真实工时
