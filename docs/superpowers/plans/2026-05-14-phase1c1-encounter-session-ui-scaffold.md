# Phase 1c.1 Implementation Plan — event 核 + learning_session + mesh + UI 脚手架

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

**Goal**：把 Phase 1c 的双 first-class entity（`encounter` + `learning_session`）一次性落地——schema、数据迁移、server code rename、模块演化、API rename、AI prompts、测试，外加 UI 脚手架（让 1c.2 五页有家可回）。Phase 1c.1 收尾时：mistake / ingestion_session / artifact 三张表 DROP，新 schema 长成，UI 框架可见 health 页面。

**Spec**：`docs/superpowers/specs/2026-05-14-phase1c-design.md` + addendum `docs/superpowers/specs/2026-05-15-phase1c-loom-design-addendum.md`

**ADRs**：
- ADR-0006（encounter 替换 mistake）
- ADR-0007（单用户假设）
- ADR-0008（LearningSession 多态 envelope）
- 演化 ADR-0005（IngestionSession single-owner → LearningSession single-owner）

**前置（不可妥协）**：Sub 0c 完全 merge 到 main。`git log main --oneline` 含 sub-0c 收尾 commit；CI 绿。

**预估**：10-14 d 单人推进，13 个 Step。

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

## Step 3: 数据迁移脚本（mistake → encounter，ingestion_session → learning_session）

写 `scripts/migrate-phase1c1.ts`（参考 Sub 5 export/import 风格）：

- 读 `mistake` 全表 → 每行映射：`outcome='wrong'`、`material_ref={kind:'question', id:question_id}`、`evidence={wrong_answer_md, wrong_answer_image_refs, cause}` → INSERT 进 `encounter`
- 读 `ingestion_session` 全表 → 每行映射：`type='ingestion'`、`status` 平移、其他 ingestion-specific 列对齐 → INSERT 进 `learning_session`
- **未做**：DROP 旧表（留给 Step 9）

测试：建一个 fixture mistake + ingestion_session → 跑 migration → 验证新表行符合预期 + 旧表数据不变。

Commit：`feat(1c.1): data migration script — mistake/ingestion_session → encounter/learning_session`

---

## Step 4: Server 端 rename — mistake → encounter（**Big Bang**）

机械化批量替换（**不**修改逻辑）：

- `src/server/knowledge/attribute.ts`：`mistake` 表引用 → `encounter` 表；写入时 `outcome='wrong'`、cause 入 `evidence.cause`
- `src/server/knowledge/propose.ts`：同上
- `src/server/knowledge/review.ts`：query mistake → query encounter（仍 filter outcome='wrong'）
- `src/server/export/csv.ts`：encounter 列、evidence 拆出
- 所有 `import { mistake } from '@/db/schema'` → `import { encounter } from '@/db/schema'`
- 全部相关 test 同步改

**注意**：本步**写代码用 encounter 表**，但**老 mistake 表仍未删**（Step 9 删）。在测试里 verify：所有路径只写 encounter，不写 mistake。

`pnpm test` 全绿；`grep -r "table.*mistake\|from.*mistake\b" src/ app/` 期望仅在迁移脚本中出现。

Commit（可分多 sub-commit）：`refactor(1c.1): server rename mistake → encounter (knowledge / export)`

---

## Step 5: IngestionSession 模块演化 → `src/server/session/`

> 这是本 plan 最复杂的一步。参考 ADR-0008 的演化路径。

- 新建 `src/server/session/index.ts` —— 多态入口
- 新建 `src/server/session/ingestion.ts` —— 把 `src/server/ingestion/session.ts` 的实现搬过来，命名空间改为 `LearningSession.Ingestion.*`
- 新建 `src/server/session/review.ts` —— 最小状态机：`started → completed | abandoned`
- 删 `src/server/ingestion/session.ts`（搬空了）
- 所有调用方（OCR handler / rescue / import route / extract route）改 import `from '@/server/session'`
- API 命名保留 `/api/ingestion/*` 不动（语义本身没变），但内部写 `learning_session(type='ingestion')`
- 单一所有者 invariant verify：grep `db.update(learning_session)` 在模块外应 zero hit；grep `db.update(encounter).*status` 同理

`pnpm test` 全绿。

Commit：`refactor(1c.1): IngestionSession → LearningSession multi-type module (ADR-0005 evolved by ADR-0008)`

---

## Step 6: API rename — `/api/mistakes` → `/api/encounters`

- `app/api/mistakes/route.ts` → `app/api/encounters/route.ts`
- `app/api/mistakes/recent/route.ts` → `app/api/encounters/recent/route.ts`
- POST body schema 调整：客户端可送 `outcome`（默认 'wrong' 向后兼容）+ evidence shape
- 所有 route test 改 path

Commit：`refactor(1c.1): API rename /api/mistakes → /api/encounters`

---

## Step 7: AI prompts + registry 更新

- `src/ai/registry.ts` 各 task system prompt：
  - "错题" 在用户面文案保留（"做错的题目"），但 entity 命名提到 mistake 的统一改 encounter
  - AttributionTask: input 改 encounter shape，output 仍 cause
  - KnowledgeReviewTask: tree snapshot + recent encounters (filter outcome='wrong'，与历史一致)
  - 其他 task 同理
- 测试：AI runner 自测（registry parse + runTask 仍工作）

Commit：`refactor(1c.1): AI prompts + registry — entity rename mistake → encounter`

---

## Step 8: 跑数据迁移（一次性脚本 + 整合到 db:push 流程）

> 严格按顺序：**Step 1-7 已 merge** → 老 mistake/ingestion_session 数据 + 新 encounter/learning_session 空表共存 → 跑迁移。

- Production（NAS）维护窗：手动 `pnpm tsx scripts/migrate-phase1c1.ts` 跑一次
- Dev：写 `tests/global-setup.ts` 钩子，testcontainer 初次 `db:push` 后自动跑（**幂等**：如果 encounter 已有数据则跳过）
- 整合后跑全套测试，**期望全绿**

Commit：`feat(1c.1): execute data migration in test setup + add prod migration script`

---

## Step 9: DROP 旧表 — mistake / ingestion_session / artifact

> 不可逆点。本步**之前**所有代码必须已切到新表。

- Drizzle schema：删除 `mistake` / `ingestion_session` / `artifact` 表定义
- `pnpm db:generate` 出 DROP migration
- 同时 `src/core/schema/generated.ts` 重新 generate（生成的 Zod 类型同步消失）
- 测试 round-trip：跑测试套件 + 全栈 grep `mistake\|ingestion_session\|artifact` 在 schema/migration 外应 zero hit

Commit：`feat(1c.1): DROP mistake / ingestion_session / artifact tables — point of no return`

---

## Step 10: UI 脚手架 — Next.js routing + Zustand + TanStack Query + loom design system

> **修订 2026-05-15**（addendum L1 + L3）：drop shadcn，直接 port loom Primitives + 直接 lift design tokens 进 `@theme`。

- 替换 `app/page.tsx`：redirect 到 `/today`（addendum L2 拍板 home = today）
- `app/layout.tsx`：globals.css import、TanStack Query Provider、Zustand store provider
- `src/ui/lib/queryClient.ts`：TanStack Query 单例配置
- `src/ui/stores/`：Zustand stores skeleton（先空：session store / encounter store）
- `app/globals.css`：Tailwind v4 + **直接 lift `docs/design/loom-design/project/colors_and_type.css` 进 `@theme` 块**（warm paper + ink + 单一 coral + FSRS 3 档；spec addendum L3 列出完整字段映射）
- 字体：Google Fonts CDN 装 `Source Serif 4` / `Noto Serif SC` / `JetBrains Mono`；MiSans 默认回落 PingFang SC（addendum L8.1；要 ship 时 drop `public/fonts/MiSans-Normal.ttf` + `@font-face`）
- 资源 lift：copy `docs/design/loom-design/project/assets/loom-{monogram,wordmark}.svg` + `icon-{192,512}.png` 到 `public/`
- `src/ui/primitives/`：port loom `Primitives.jsx` 的 10 个原子到 TSX 文件——`Brand.tsx` / `Icon.tsx`（用 `lucide-react` 替 loom 的 inline SVG，loom README 自己说"closest match is lucide-react"）/ `Button.tsx` / `Badge.tsx` / `StatusBadge.tsx` / `CauseBadge.tsx` / `Card.tsx` / `PageHeader.tsx` / `TopNav.tsx` / `TabBar.tsx`
- `app/health/page.tsx`：测试页面，GET `/api/health` 显示 status（用 loom `<Card>` + `<Badge>` 验证 Primitives 通了）

`pnpm dev` 启起来；浏览器访问 `/health` 显示 OK + 视觉用 loom palette 渲染。

Commit：`feat(1c.1): UI scaffold — Next.js routing + Zustand + TanStack Query + Tailwind v4 tokens`

---

## Step 11: 烟测 + 验证 invariant

- `pnpm test` 全绿
- `pnpm typecheck` 全绿
- `pnpm lint` 全绿
- grep 健康度：
  - `mistake` 在 src / app 内零 hit
  - `ingestion_session` 在 src / app 内零 hit（migration 脚本除外）
  - `artifact` 在 src / app 内零 hit
  - `db.update(learning_session)` 仅在 `src/server/session/` 出现
  - `db.update(encounter).*status` 同上
- 集成测试：跑一次完整 ingestion → import → encounter 创建 → review submit → encounter outcome='reviewed' 写入

Commit：`test(1c.1): single-owner invariant verified across encounter + learning_session`

---

## Step 12: docs — architecture.md + CONTEXT.md provisional → final

- `docs/architecture.md`：
  - "录入会话状态机" 章节 → 升级为 "学习会话 (LearningSession) 多态状态机"
  - 加 "encounter — first-class learning event" 章节
  - 删除任何 "mistake 是学习记录核心" 的描述
- `CONTEXT.md`：
  - "提议中" 节标题改为 "核心实体（Phase 1c.1 后正式生效）"
  - 删除 provisional 标记
  - "错题（mistake）" 旧词条 → 改为 "encounter (outcome='wrong')" 的别名注解
- `README.md`：如有提到 mistake 的，同步更新

Commit：`docs(1c.1): architecture.md + CONTEXT.md — encounter / learning_session promoted to canonical`

---

## Step 13: PR

```bash
gh pr create --title "Phase 1c.1: encounter + learning_session full restructure + UI scaffold" \
  --body "$(cat <<'EOF'
## Summary
- Phase 1c.1 实现 spec docs/superpowers/specs/2026-05-14-phase1c-design.md
- ADRs: 0006 (encounter) / 0007 (single-user) / 0008 (LearningSession)
- mistake / ingestion_session / artifact 三表 DROP；encounter + learning_session 取代
- IngestionSession 模块 (ADR-0005) 演化为 LearningSession 多态模块 (ADR-0008)
- UI 脚手架就位，1c.2 五页可以开始落

## Test plan
- [ ] pnpm test 全绿
- [ ] pnpm typecheck 全绿
- [ ] grep verify: mistake/ingestion_session/artifact 在 src/app/ 零 hit
- [ ] 集成测试: ingestion → import → encounter → review 全链路
- [ ] pnpm dev + 浏览器 /health 显示 OK

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
