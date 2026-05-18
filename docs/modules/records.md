# 学习记录（LearningRecord）

> 本文替代旧 `StudyLog` 设计。由于当前没有真实数据，采用一次性破坏式迁移：删除
> `study_log` 概念，重建 `/record`、API、schema 和 agent tools。

## 0. 设计决策（2026-05-18）

`/record` 不是“录错题”，也不是一个自由笔记桶。学习上下文应该由用户在系统内的
活动创造：做题、订正、阅读、提问、上传材料、接受/拒绝 proposal、复盘、给某个
知识点追加旁批。`LearningRecord` 只是把这些活动中值得保留的上下文物化出来。

`LearningRecord` 是用户可见的记录对象；`event` 仍然是事实动作流。两者分工：

| 层 | 负责什么 | 例子 |
|---|---|---|
| `learning_record` | 由用户活动产生、用户可见的学习上下文 | 错题、做对但值得保留的例题、疑问、顿悟、反思、资源摘录 |
| `event` | 会影响学习状态的动作事实 | `attempt(success/failure/partial)`、`judge`、`review`、`rate`、tool-use trace |
| `question` | 可复习/可出题的题面实体 | 错题题面、变式题、worked example promoted 后的题 |
| `artifact` | AI 或工具产出的结构化内容 | note、summary、quiz、resource extraction |

未来 memory 层不直接等同于 `LearningRecord`。三层关系是：

| 层 | 生成方式 | 语义 |
|---|---|---|
| `event` | 系统自动写入 | 事实流水：用户/agent 做过什么 |
| `learning_record` | 从用户活动中显式保存或自动物化，AI 可辅助整理 | 原始学习上下文：值得保留的学习现场 |
| `memory_brief_note` | Dreaming 周期性从 records / events / graph / proposal feedback 中提炼 | 三段短文：近一周、近几个月、长期重要 memory |
| `memory`（future full layer） | AI 从 brief note + evidence 中进一步结构化，用户可校正 | 可检索的偏好、反复误区、学习策略、长期目标 |

关键原则：

- 所有确认过的作答都应写 `event(action='attempt')`，`outcome` 可为
  `success | failure | partial`。做对本身是学习信号。
- 每道进入 `question` 表的题都有自己的生命周期证据：`question.created_at` 是记录时间，
  attempts/reviews 走 event 流，当前复习调度走 `material_fsrs_state`。`LearningRecord`
  只是其中值得保留的上下文，不承担完整题目历史。
- 错题是 `LearningRecord(kind='mistake')` + `event(action='attempt', outcome='failure')`。
- 做对题默认是 success attempt event；只有当它值得保留为例题、反思或资源时，才额外物化
  `LearningRecord(kind='worked_example' | 'reflection' | ...)`。
- 每条 `LearningRecord` 必须能追溯到一个用户活动：优先通过 `origin_event_id` 指向
  触发它的 event；全局手动录入也先写入一个 capture event，再物化 record。
- 不创建脱离系统活动的孤立文本记录。用户写下的文字是活动的 payload/annotation，
  不是独立于学习过程之外的笔记本。
- 非错题记录不伪造成 attempt event。
- `LearningRecord` 是 memory 的证据来源，不是 memory 本身。
- 不依赖用户手动维护 memory；用户负责捕获和校正，Dreaming 负责周期性刷新
  `memory_brief_note`，并保留 evidence ids。
- 旧 `/study-log` 页面和 `study_log` 表应删除；开发期可让 route 返回 `410 Gone`，不保留双模型。
- agent 读上下文时默认读 `query_records`，不是分别读 `query_mistakes` 和 `query_study_log`。

## 1. Record kinds

```ts
type LearningRecordKind =
  | 'mistake'
  | 'worked_example'
  | 'open_question'
  | 'insight'
  | 'reflection'
  | 'observation'
  | 'resource_note';
```

| kind | 语义 | 是否默认创建 Question | 是否影响 mastery |
|---|---|---:|---:|
| `mistake` | 用户做错过，需要归因/复习 | 是 | 是，创建 failure attempt |
| `worked_example` | 做对但值得保留的题/例题 | 可选 | record 本身不影响；关联的 success attempt 可作为掌握信号 |
| `open_question` | 用户没想清楚的问题 | 否 | 否，可触发答疑/学习项 proposal |
| `insight` | 顿悟、理解变化 | 否 | 不直接影响，可作为 completion evidence |
| `reflection` | 阶段复盘 | 否 | 不直接影响，喂 Coach/WeeklyReview |
| `observation` | 一般规律观察 | 否 | 不直接影响 |
| `resource_note` | 书/讲义/网页/图片摘录 | 可选 | 否，后续可拆成 note/question |

## 2. Schema target

```ts
learning_record
  id text primary key
  kind text not null
  title text
  content_md text not null default ''
  source text not null              // manual | ocr | import | conversation | agent
  capture_mode text not null        // text | image | paper | voice | url | mixed
  activity_kind text not null       // attempt | review | read | ask | annotate | import | conversation | plan
  processing_status text not null   // raw | linked | actioned | archived

  // provenance
  origin_event_id text              // event that created/materialized this record

  // common links
  subject_id text
  knowledge_ids jsonb string[] not null default []
  question_id text
  attempt_event_id text             // for kind='mistake'
  learning_item_id text
  artifact_id text
  source_document_id text
  asset_refs jsonb string[] not null default []

  // typed payload, kept small and kind-specific
  payload jsonb not null default {}

  created_at timestamptz not null
  updated_at timestamptz not null
  archived_at timestamptz
  version int not null default 0
```

`payload` examples:

```ts
// kind='mistake'
{
  wrong_answer_md: string;
  wrong_answer_image_refs?: string[];
  user_cause?: { primary_category: CauseCategory; user_notes?: string | null };
}

// kind='worked_example'
{
  prompt_md?: string;
  reference_md?: string | null;
  why_keep_md?: string;
}

// kind='open_question'
{
  question_md: string;
  blocking?: boolean;
}

// kind='resource_note'
{
  source_title?: string;
  source_url?: string;
  excerpt_md?: string;
}
```

Do not add a generic `learning_record_link` table in the first migration. The current
record surface only needs one primary question / attempt / artifact / learning item plus
`knowledge_ids[]`. Add a link table only after records need multiple typed links with
per-link metadata.

Invariant: `origin_event_id` should be non-null for normal runtime records. Import/dev seed may
temporarily leave it null, but API-created records must either reference an existing event or create
the triggering capture event in the same transaction.

## 3. Creation flows

### 3.1 Mistake

One transaction:

1. Insert `question`.
2. Insert `event(action='attempt', subject_kind='question', outcome='failure')`.
3. Insert `learning_record(kind='mistake', activity_kind='attempt', origin_event_id=attempt_event_id, question_id, attempt_event_id, payload.wrong_answer_md, knowledge_ids)`.
4. If user supplied cause, insert `event(action='experimental:user_cause', caused_by_event_id=attempt_event_id)`.
5. Enqueue attribution / knowledge proposal / variant jobs as today.

`attempt_event_id` remains the FSRS/mastery signal. `learning_record.id` is the UI record id.

### 3.2 Correct / partial attempts

When a user confirms a solved question from review, quiz, or imported homework, write:

```text
event(action='attempt', subject_kind='question', outcome='success' | 'partial')
```

This event is a learning signal even if no `LearningRecord` is created. It can feed mastery,
weekly review, graph recency, and agent context. Do not hide correct attempts inside
`question_block`; `question_block` is only the extraction/review staging area.

Only create a record when the correct/partial attempt carries reusable context:

- `worked_example`: "I got it right, but the method is worth keeping."
- `reflection`: "I got it right only after seeing a hint."
- `observation`: "This type is faster with method A."

### 3.3 Worked example

Two acceptable paths:

- Lightweight: successful attempt / reading / annotation event creates
  `learning_record(kind='worked_example', origin_event_id, activity_kind)`.
- Promoted: insert `question` and set `learning_record.question_id`.

Promotion can happen later through a user action or agent proposal. Doing the question insert
only when needed avoids polluting the review queue with every saved example.

### 3.4 Open question / insight / reflection / observation

The record is created from an activity event: asking in chat, annotating a note, finishing a review,
or writing a reflection from a knowledge/question page. Agent may later propose:

- link to knowledge nodes,
- create LearningItem,
- answer the open question,
- promote a useful prompt into a question.

These proposals remain separate from the record itself.

### 3.5 Resource note

Upload/import/read/highlight first writes the corresponding event, then inserts
`learning_record(kind='resource_note')` with `origin_event_id`, `asset_refs` /
`source_document_id` when available. Later ingestion can derive notes, questions, or knowledge
proposals from this record.

### 3.6 Mixed homework page

A photographed homework page is one capture/import activity, then many question-level signals:

1. Store original page assets and extraction evidence in `source_document` / `source_asset` /
   `question_block`.
2. For every confirmed answered block, insert or link a `question`.
3. Preserve the question's lifecycle provenance: `question.created_at`, `source`,
   `source_ref`, and metadata such as origin block / asset / crop refs.
4. For wrong blocks, insert `event(action='attempt', outcome='failure')` plus
   `learning_record(kind='mistake')`.
5. For correct blocks, insert `event(action='attempt', outcome='success')`. Do not create a
   record by default.
6. If a correct block is worth keeping, also create
   `learning_record(kind='worked_example', origin_event_id=<success_attempt_event_id>)`.

This keeps correctness evidence complete without flooding the record surface.

## 4. API target

Replace `/api/study-log` and narrow `/api/mistakes` creation with `/api/records`.

```text
GET    /api/records
POST   /api/records
GET    /api/records/[id]
PATCH  /api/records/[id]
DELETE /api/records/[id]          // soft archive
POST   /api/records/[id]/promote  // proposal/action: question | learning_item | artifact
```

Filters:

```ts
{
  kind?: LearningRecordKind | LearningRecordKind[];
  knowledge_ids?: string[];
  subject_id?: string;
  activity_kind?: string | string[];
  origin_event_id?: string;
  question_id?: string;
  attempt_event_id?: string;
  learning_item_id?: string;
  processing_status?: 'raw' | 'linked' | 'actioned' | 'archived';
  time_range?: { from?: string; to?: string };
  query?: string;
  limit?: number;
}
```

Compatibility:

- `/api/mistakes` can survive as a read alias for `GET /api/records?kind=mistake`.
- `POST /api/mistakes` should be removed once `/record` is migrated.
- `/api/study-log` should be deleted or return `410 Gone` in development, because keeping it
  alive preserves the bad model.

## 5. UI target

`/record` becomes the single capture surface, but it should usually open with the current activity
as context rather than a blank note editor.

Top-level kind selector:

- 错题
- 例题
- 疑问
- 顿悟
- 反思
- 观察
- 资源摘录

Capture mode is orthogonal:

- text
- image
- paper/OCR
- voice later
- url/import later

`/records` or `/today` can show the timeline/list. `/study-log` should not remain a separate
primary nav item.

Activity entry points:

- 错题录入 / OCR 切题：creates attempt event + mistake record.
- 题目页（做对或做错）：always records the confirmed attempt event; optionally save as worked example / reflection against that question.
- 知识点页：add open question / reflection / observation against that knowledge path.
- 阅读 note / artifact：highlight or side-comment creates resource_note / observation.
- Chat / agent answer："保留这个问题" creates open_question from conversation event.
- Review / weekly 页面：reflection is anchored to the session or review event.

## 6. Agent tool impact

Primary read tools:

```text
query_records
get_record_context
query_mistakes              // specialized shortcut over query_records(kind='mistake')
```

Deprecated:

```text
query_study_log
```

Proposal/action tools:

```text
propose_record_links
propose_record_promotion
attribute_mistake
propose_variant
```

Important behavior:

- `query_records` returns all activity-grounded learning context, including non-mistake signals.
- `query_mistakes` remains useful because mistake attribution/review fields are specialized.
- `get_record_context` resolves the record plus its origin event, question, attempt event, judge/user cause,
  LearningItem, artifact, and knowledge paths as applicable.

## 7. Relationship To Future Memory Layer

`LearningRecord` is intentionally raw and traceable. It should not try to become a perfect
long-term learner model through manual fields. The first memory implementation is a
Dreaming-maintained `memory_brief_note`, not a vector store or editable profile.

Each brief note contains exactly three short prose sections:

| field | window | Meaning |
|---|---|---|
| `recent_week_md` | rolling 7 days | What changed recently: active topics, stuck points, new questions, review behavior |
| `recent_months_md` | rolling 90 days by default | Repeated patterns over the current learning phase |
| `long_term_md` | stable/all-time | Durable preferences, recurring misconceptions, goals, and strategies that should survive weekly churn |

The brief note is a derived snapshot. Dreaming may refresh it automatically because it does
not mutate graph facts, mastery, or LearningItem state. It must still be auditable: every
refresh writes an event and every claim should be backed by evidence ids where possible.

Inputs:

- activity-grounded `learning_record` rows,
- factual `event` chains,
- knowledge graph structure and mastery projections,
- accepted/dismissed proposals.

Expected long-term memory examples:

| memory kind | Example | Evidence |
|---|---|---|
| recurring misconception | "Often treats classical Chinese `之` as a pronoun when it is structural" | mistake records + judge events |
| learning preference | "Prefers geometry explanations with diagrams before algebraic derivation" | reflections + accepted teaching proposals |
| durable goal | "Prepare solid geometry proof methods before exam set X" | open questions + learning items |
| strategy note | "Needs contrastive examples for near-synonym function words" | repeated variant outcomes |

The later full memory layer can still be proposal-oriented:

```text
records/events/graph
  -> Dreaming brief-note refresh with evidence ids
  -> optional memory_update proposal for structured/stable facts
  -> user accept/dismiss or silent low-risk auto-refresh
  -> memory projection used by future agents
```

For the first `learning_record` migration, implement only the brief-note table and reader.
Do not implement vector search, per-fact memory objects, or a profile editor. Preserve the
hooks that make the later layer possible:

- keep records linked to questions, attempt events, artifacts, learning items, and knowledge ids,
- keep `processing_status` so async AI enrichment can mark `raw -> linked -> actioned`,
- store enough evidence ids for future memory proposals to be traceable,
- keep proposal mutations separate from raw records.

## 8. One-time migration plan

Because there is no real data, do not build a compatibility bridge.

1. Add `learning_record` schema and generated Zod types.
2. Drop `study_log` schema/routes/UI/tests.
3. Refactor `/record` to create all record kinds through `/api/records`.
4. Move mistake creation from `/api/mistakes` to `/api/records(kind='mistake')`.
5. Keep `GET /api/mistakes` only as a temporary read alias if existing UI still needs it during
   the same PR.
6. Update `query_records`, `query_mistakes`, and `get_record_context` specs/tests.
7. Regenerate migration, run `pnpm audit:schema`, `pnpm typecheck`, and targeted route tests.

No data backfill is required. Local dev databases can be reset if that is simpler than
writing transitional migrations.
