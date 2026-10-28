# Architecture Review — 2026-05-11

> **触发**：Phase 1a 5 sub 全 ship 后，发现一路 sub-level 推进**没有横向审视**核心战略：LLM-centric / Session 一等公民 / 全题入库 / 进度闭环 / 多学科。Sub 5 PR #24 codex review 暴露了 schema-fixture 漂移；Sub 6a brainstorm 发现现有 reading 处理脆弱。**复盘梳理一次，决定后续。**

> **目标**：lock 7 个跨模块决策 → audit 已 ship vs 决策 gap → 重排 Phase 1b/2 sub 顺序 → 输出此 spec 作为后续所有 sub 的横向 reference。

---

## TL;DR — 7 个 lock'd 决策

| # | 决策 | Lock |
|---|---|---|
| Q1 | Session 升格 | `ingestion_session` 重命名 `session`，加 `kind` 列；Summary 同步 at-import；polymorphism via JSON metadata；question + mistake 加 `subject` + `session_id` 一等列。 |
| Q2 | All-questions ingest | 所有题入 `question`；LLM auto-judges (Workflow async)；user 可改判；`MistakeEnrollTask` AI 决策是否入 FSRS；user 手动覆盖兜底。 |
| Q3 | Question Tag pipeline | `QuestionTaggingTask` (haiku, sync after OCR) auto-tag subject + knowledge_id_candidates + difficulty；low-confidence 触发 KnowledgePropose. |
| Q4 | 进度闭环 wiring | `base_mastery` 规则 EMA（实时）+ `ai_delta_mastery` LLM nightly (Dreaming) refines；`mastery_adjustment_log` 表 audit。 |
| Q5 | LLM 拓扑 — 两层 | Layer 1: 13 个 Tasks（registry-managed, single-shot）；Layer 2: Agents (multi-turn, stateful, tool-using)；Orchestrator 是 Layer 2。 |
| Q6 | 4 lane 分类 | Sync user-facing / Async Workflow / Cron (2 slots) / User-triggered；每 sub op 必须明确归类。 |
| Q7 | 多学科 + 网状 | Tree primary (per-subject root); 跨 subject question.knowledge_ids 允许（Option B）+ 科内 `knowledge_link` 表 (Option C) 待 Phase 2 真用。 |

**外加 stack pivot**：放弃 CF Workers，迁 **Vercel Hobby + Workflow DevKit + Vercel Cron + Neon Postgres + R2 (S3-compat)**。

---

## Q1 — Session 升格 (lock'd)

### 现状问题

- `ingestion_session` 是一次性 holder（uploaded → extracted → reviewed → imported），无 summary / 无 first-class lifecycle
- Question / mistake 通过 metadata.ingestion_session_id JSON 软链回 session — 无法高效 query "本 session 的所有题"

### Lock

**generalize ingestion_session → `session`**：

```ts
session {
  id: text primary
  kind: text not null              // 'capture' | 'review' | 'quiz' | 'orchestrator_chat' | 'study_log' | ...
  status: text not null            // kind-specific status
  summary_json: text(json)         // {subject, session_kind, human_summary_md} — see below
  metadata: text(json)             // kind-specific fields (capture: source_asset_ids, source_document_id, entrypoint; chat: messages; etc.)
  created_at, updated_at, version
}
```

**summary_json shape** (capture session)：

```ts
{
  subject: string,                 // "语文" / "数学" / etc.
  session_kind: string,            // '试卷' | '练习题包' | '错题本' | ...
  human_summary_md: string,        // ~100-300 字简短描述，给人看
}
```

**knowledge_rollup 不存** — 派生自 question + judgment 跨表 join (per Q4 decision)。

**Summary 时机**：sync at import 时跑 `SessionSummaryTask` (haiku, ~10s)。Worker timeout 不再是问题（已 stack pivot 至 Vercel）。

**新一等列**（query pattern 要求）：
- `question.subject TEXT NOT NULL`（denormalized from session 或 knowledge_id 推断）
- `question.session_id TEXT REFERENCES session(id)`
- `mistake.session_id TEXT REFERENCES session(id)`（导出时方便）

**Index**：`(subject)`, `(session_id)`, `(subject, created_at)`, `(session_id, created_at)`.

### 多 kind session 例

- `kind='capture'`: import 流的 session，包含 source_asset_ids
- `kind='review'`: 一次 FSRS 复习会话；包含 review_event_ids[]
- `kind='quiz'`: 用户主动一次答题；包含 question_ids[] 答题顺序
- `kind='orchestrator_chat'`: agent 多轮对话；包含 messages[]
- `kind='study_log'`: （未来 Sub）用户主动记录的会话级日志

每 kind 在 sub 实施时定义自己 metadata schema（zod）+ summary 内容。

---

## Q2 — All-questions ingest (lock'd)

### 现状问题

Capture import 直接建 mistake；question + answer + judgment + user_appeal schema 已就位但**0 代码使用**。"正确题目"未入库。

### Lock — 数据流统一

```
[Capture import] 每题:
  1. question 行（必有）
  2. answer 行（OCR 抽出的用户答 / 录入时填的答）
  3. (async, Workflow) judgment 行（verdict: 'correct' | 'partial' | 'incorrect' + score + feedback）
  4. (async, 接 Judge 后) MistakeEnrollTask 决策 — enroll → mistake 行 + init fsrs_state；reject → 不进 FSRS

[Quiz / Review] 用户做题:
  → answer + judgment + (maybe) mistake — 同下游

[FSRS Review] 复习错题:
  → answer (新 attempt) + judgment (新评分) + 更新 mistake.fsrs_state

闭环：所有题目 encounter 都过 answer + judgment 表。
mistake = MistakeEnrollTask 决策 enroll 的子集。
```

### LLM Judge

- **Sonnet vision**（手写图识别 + 多模态判断）
- 每题 ~15-25s（含 vision processing）
- **Async via Vercel Workflow DevKit**（30 题并行 ~3-4 分钟总）
- 用户在 capture review 看 LLM verdict 实时 fill-in；可点击改判（建新 judgment + `prior_judgment_id` 链）

### MistakeEnrollTask

- **Haiku**（cheap，二元决策）
- Trigger：仅 `verdict ∈ {incorrect, partial}`
- Input：judgment + question + answer + 最近 N 次同题/同 knowledge attempts
- Output：`{enroll: bool, reason: string, suggested_initial_fsrs_difficulty?: number}`
- enroll → 建 mistake + init fsrs_state；reject → 不进 FSRS（question / answer / judgment 仍入库）
- **用户手动覆盖**：UI "+ 加入复习" 按钮兜底 AI 误判

### 同 question 多次 attempt

- 同一 question 已有 active mistake → 不再建 mistake，仅追加 answer + judgment + 更新 fsrs_state
- 已存在的 mistake 永不自动 archive（FSRS 调度自动让易题低频）

---

## Q3 — Question Tag pipeline (lock'd)

### Lock — `QuestionTaggingTask`

**Haiku**, **sync 紧接 OCR**（user 看 capture review 时 tags 已就位）：

```ts
input: {
  prompt_md, image_bytes, reference_md,
  knowledge_tree_subset            // 仅当 subject 范围内的 nodes
}
output: {
  subject: string,
  knowledge_id_candidates: [{ id, confidence }],   // 按 confidence DESC
  difficulty: number,                               // 1-5
  propose_new_node?: { name, parent_id, reasoning } // 全部 candidates < 0.5 时填
}
```

### Capture pipeline 时间线

```
[Upload]
  ↓
[OCR Tencent QuestionSplitOCR ~30s]            sync
  ↓
[StructureTask LLM (reading split etc.) ~30s]  sync (仅 reading 题或低置信触发)
  ↓
[QuestionTaggingTask fan-out per question ~30-60s parallel via Workflow]  sync
  ↓
[Capture review page 打开] user 编辑 tags / structure / answer
  ↓
[user click import]
  ↓
[Sync: 建 question+answer 行 + SessionSummary ~10s]
  ↓
[Async Workflow ~3-4min: JudgeTask per-question parallel → MistakeEnrollTask → AttributionTask + KnowledgeProposeTask]
  ↓
[base_mastery EMA update on each judgment landing]
```

总 sync 等待：~1.5-2 分钟（user 等)。Async：~3-4 分钟（用户可关页面）。

### `KnowledgeProposeTask` 触发

- 旧：每 mistake create 后即时（waitUntil）
- **新**：QuestionTagging 输出 `propose_new_node` 时累积；nightly Dreaming 批量 review + 入 `dreaming_proposal` 表
- 减少 noise + 节省 LLM 成本

---

## Q4 — 进度闭环 wiring (lock'd)

### Lock — Hybrid（规则 base + LLM ai_delta）

**`knowledge.base_mastery`** — 规则 EMA：

```
on each judgment 入库（同步）:
  for knowledge_id in question.knowledge_ids:
    decay_factor = 0.98 ** days_since_last_active
    new_base = current_base * decay_factor + judgment.score * 0.1
    new_base = clamp(new_base, 0, 1)
    update knowledge.base_mastery + last_active_at
```

**`knowledge.ai_delta_mastery`** — LLM nightly Dreaming：

```
MasteryAdjustTask (Phase 2 Dreaming cron):
  for each knowledge node:
    LLM input: 节点 name, base_mastery, recent N judgments on it, 用户 study_log mentions
    LLM output: { new_ai_delta: -0.2 to +0.2, reason_md }
  写 mastery_adjustment_log 表 (audit)
  update knowledge.ai_delta_mastery
```

**显示**：

```
final_mastery = clamp(base_mastery + ai_delta_mastery, 0, 1)
UI hover knowledge node 看拆解 + 链 mastery_adjustment_log
```

### 新加 audit 表

```ts
mastery_adjustment_log {
  id text primary
  knowledge_id text references knowledge.id
  prior_base, prior_ai_delta: real
  new_ai_delta: real
  reason_md: text                    // LLM 解释
  dreaming_run_id: text              // 链回触发 task run
  evidence_summary: text(json)       // {cited_judgment_ids[], cited_question_ids[]}
  created_at: integer
}
```

User UI：
- knowledge node 显 final_mastery
- hover → tooltip 拆解 base / ai_delta
- 点 ai_delta 历史 → mastery_adjustment_log 列表 + LLM reason
- "回滚" 按钮（手动 set ai_delta = prior_ai_delta，仅紧急）

---

## Q5 — LLM 拓扑 (lock'd)

### 两层模型

```
[Layer 2: Agents] (multi-turn, stateful, tool-using)
└── OrchestratorAgent (Phase 2)
    ├── chat_session 持化 messages + scratch
    ├── tool-calls Layer 1 tasks
    ├── 决策 A 错题复习 / B 新知识学习 / C 全局教练
    └── 写 proposal / 启动 quiz / 派 dreaming 等

       ↓ agents 把 tasks 当 tools 用 ↓

[Layer 1: LLM Tasks] (single-purpose, stateless, registry-managed)
```

### Layer 1 task 完整列表（13 个）

| # | Task | 状态 | Trigger | Model | Lane |
|---|---|---|---|---|---|
| 1 | AttributionTask | ✅ | judgment 完成 → mistake 创建 | sonnet | async (Workflow) |
| 2 | VisionExtractTask | ✅ Sub 4C | OCR Tier 2 | haiku | sync (cascade) |
| 3 | VisionExtractTaskHeavy | ✅ Sub 4C | OCR Tier 3 | sonnet | sync (cascade) |
| 4 | KnowledgeProposeTask | ✅ Sub 1 | 累积，nightly batch | sonnet | cron (Dreaming) |
| 5 | KnowledgeReviewTask | ✅ Sub 1 | manual trigger | sonnet | user-triggered |
| 6 | **SessionSummaryTask** | 🆕 Q1 | session close | haiku | sync at close |
| 7 | **JudgeTask** | 🆕 Q2 | judgment.status='pending' | sonnet vision | async (Workflow) |
| 8 | **MistakeEnrollTask** | 🆕 Q2 | judgment ∈ {incorrect, partial} | haiku | async (Workflow chain) |
| 9 | **QuestionTaggingTask** | 🆕 Q3 | OCR 完成后 | haiku | sync (capture review) |
| 10 | **MasteryAdjustTask** | 🆕 Q4 | nightly cron | sonnet | cron (Dreaming) |
| 11 | VariantsGenTask | Phase 2 | weekly cron | sonnet | cron (Maintenance) |
| 12 | DreamingProposeTask | Phase 2 | nightly cron | sonnet | cron (Dreaming) |
| 13 | MaintenanceReviewTask | Phase 2 | weekly cron | sonnet | cron (Maintenance) |

### Layer 2 — OrchestratorAgent

**新表**：`agent_session` (kind='orchestrator_chat'，per Q1 generalized session)：

```ts
metadata: {
  messages: Array<{role: 'user'|'assistant'|'tool', content: string, tool_calls?: [...]}>,
  scratch: text(json),                  // agent 内部 working memory
  tool_call_history: [...]              // 链回 tool_call_log
}
```

**Runtime**：基于 Vercel AI SDK 的 agent / tool-calling loop。每轮：
1. Read state (messages + scratch + 当前 user input)
2. LLM 决策（生成响应 + 可能调 tool）
3. Exec tools（call Layer 1 task / write DB）
4. 更新 state + 等下一轮 user input

### Infra gaps（待补）

1. **Workflow DevKit setup** (Stack Migration 范围)
2. **Pending status 可见性**：judgment.status enum (`pending` / `ready` / `failed`) + 前端 poll 端点
3. **统一 task_run_id audit**：tool_call_log 已有；新表（mastery_adjustment_log）也带
4. **Cost cap**：当前每 task budget；月度总 cap 待 Phase 2 加
5. **Agent runtime**：Phase 2 Sub 7 落实

---

## Q6 — Lane 分类 (lock'd)

### 4 个 lane

| Lane | 特征 | Op |
|---|---|---|
| **Sync user-facing** | 用户阻塞等结果 | OCR + StructureDetect + Tagging（capture review）<br>SessionSummary（import 时）<br>Orchestrator chat 单轮<br>KnowledgeReview manual<br>base_mastery EMA<br>question + answer 行写入 |
| **Async Workflow DevKit** | import 立即返回，背后跑 | JudgeTask + MistakeEnrollTask<br>AttributionTask（修改：原 waitUntil → 迁 Workflow）|
| **Cron (Vercel 2 slots)** | 定时触发 | **Daily 18:00**: DreamingProposeTask + MasteryAdjustTask + KnowledgeProposeTask batch<br>**Weekly 周日 02:00**: MaintenanceReviewTask + VariantsGenTask batch |
| **User-triggered** | 用户主动按钮 | KnowledgeReviewTask trigger<br>Orchestrator agent 启动<br>手动 mistake enroll<br>手动 trigger Variants gen |

### 时间线

```
[Capture upload]
  ┌─ SYNC ─────────────────────────────────────────┐
  │ OCR Tencent (~30s) → StructureDetect (~30s)    │
  │ → Tagging (~30-60s) → review page              │
  │ User edits → import → SessionSummary (~10s)    │
  └────────────────────────────────────────────────┘
                       ↓ import 返回
  ┌─ ASYNC Workflow (~3-4 min) ────────────────────┐
  │ JudgeTask (per question, parallel)             │
  │  ↓                                              │
  │ MistakeEnrollTask (verdict ∈ partial/inc 才触) │
  │  ↓                                              │
  │ AttributionTask (mistake create 后)            │
  │  ↓ (rule, sync)                                 │
  │ base_mastery EMA update                        │
  └────────────────────────────────────────────────┘

[Daily Cron 18:00]
  DreamingProposeTask + MasteryAdjustTask
  + KnowledgeProposeTask 累积 batch
  → dreaming_proposal table; mastery_adjustment_log

[Weekly Cron 周日 02:00]
  MaintenanceReviewTask + VariantsGenTask batch
  → dreaming_proposal table; new variant questions
```

---

## Q7 — 多学科 + 网状 (lock'd)

### Tree primary（每 subject 顶级根节点）

```
[root: 语文 (id=subject_yuwen)]    [root: 数学 (id=subject_math)]
    ↓                                  ↓
  文言文 / 现代文 / 古诗            函数 / 几何 / ...
    ↓                                  ↓
  虚词 / 实词 / 句式                 二次函数 / ...
```

- `knowledge.domain TEXT NOT NULL` = subject 名（'语文', '数学', '英语'...）
- 每 subject 一个根节点
- 现 wenyan 树 migration：
  - 创建 `subject_yuwen`（domain='语文'）
  - 现 wenyan 根改 parent_id = subject_yuwen 下的"文言文"节点
  - 整体 domain 从 'wenyan' → '语文'

### 跨 subject question.knowledge_ids 允许（Option B）

```
question.knowledge_ids = ['lang-reading', 'lang-inference', 'math-logic']
                          ↑              ↑                  ↑
                          domain='语文'   domain='语文'     domain='数学'
```

- 每 knowledge 严格归一 subject
- 但一道 question 可挂跨 subject 的 ids（罕见但允许）
- mastery 各自独立累计（语文-阅读理解 mastery 涨；数学-逻辑推理 mastery 也涨）

### 科内 knowledge_link 表（Option C, schema 加 Phase 1b，Phase 2 用）

```ts
knowledge_link {
  id text primary
  from_id text references knowledge.id
  to_id text references knowledge.id
  relation: 'uses' | 'prerequisite' | 'generalizes' | 'related' | 'compose_with'
  weight: real default 1.0
  notes_md: text
  created_at: integer
}
```

**约束**：`from_id.domain === to_id.domain`（科内 only，跨学科罕见 case 走 question.knowledge_ids 即可）。

**`relation` 语义**：
- `uses` — 模型 ↔ 公式（用 X 实现 Y）
- `prerequisite` — 必须先掌握 X 才学 Y
- `generalizes` — Y 是 X 特例
- `related` — 弱关联
- `compose_with` — 一起出现

**Phase 1b**：schema 加表 + /knowledge UI 手动建 link；不做 mastery propagation / graph 可视化。
**Phase 2**：Mastery propagation via links；force-directed graph view；Variants/Orchestrator 决策走 link。

---

## Stack Pivot — 放弃 Cloudflare Workers

### 痛点

CF Workers 30s timeout + 50 subrequest 限制 + 不支持 long-running cron / queue 不够灵活 → LLM-heavy 设计跑不动（每题 vision judge ~15-25s × 30 题 → 10+ 分钟）。

### 新 stack lock

| 维度 | 旧 (CF) | 新 (Vercel) |
|---|---|---|
| Compute | CF Workers | **Vercel Hobby Functions** (60s/step, Workflow DevKit 跨 step 无总限) |
| 数据库 | D1 (SQLite) | **Neon Postgres** (free tier 0.5GB) |
| 对象存储 | R2 | **R2 保留**（用 S3-compat client） |
| Auth | x-internal-token middleware | 同（Hono 中间件不变）|
| LLM | Vercel AI SDK | 同 |
| OCR | Tencent EduPaperOCR | **Tencent QuestionSplitOCR**（结构化更细）|
| Long-running | waitUntil + 拆 chunk | **Vercel Workflow DevKit**（durable steps）|
| Cron | 无 | **Vercel Cron** (Hobby 2 slots) |

### 迁移要点

1. **D1 → Neon Postgres**：
   - drizzle-orm 同 ORM；driver 换 `drizzle-orm/postgres-js`
   - SQL syntax 微调：`json_extract(col, '$.field')` → `col->'field'` / `col->>'field'`
   - Boolean: `integer({mode: 'boolean'})` → `boolean()`
   - Timestamp: `integer({mode: 'timestamp'})` → `timestamp({withTimezone: true})`
   - Auto-increment ids: 现用 cuid2 不变

2. **Hono Workers adapter → Vercel adapter**：`@hono/vercel`，handler 形态变

3. **Tencent OCR sign**：TC3-HMAC-SHA256 同协议；CF 用 crypto.subtle，Node 用 crypto。helpers 重写

4. **Workflow DevKit 接入**：所有 async lane task 走 Workflow

5. **R2 client 保留**：从 Vercel functions 用 `aws-sdk/client-s3` 配 R2 endpoint

6. **环境变量 / secrets**：从 wrangler secret 迁 Vercel env vars

### 估时

迁移 ~5 天（含 18 路由 smoke + Tencent OCR API 升级 + Workflow setup）。

---

## Audit — 已 ship vs lock'd 决策

| Sub | 状态 | Gap |
|---|---|---|
| Sub 1 knowledge schema seed | ✅ | Q7：domain='wenyan' → '语文'；reparent；knowledge_link 表加 |
| Sub 2 manual 录入 | ❌ Sub 4C 退役 | N/A |
| Sub 3 AttributionTask | ✅ | Q5/Q6：waitUntil → Workflow async lane |
| Sub 4A FSRS review | ✅ | Q1：复习应是 session.kind='review'；review_event + session_id |
| Sub 4B LearningItem 三态 | ✅ | 无即时 break |
| Sub 4C Capture flow + OCR | ✅ | **大重做**：OCR Tier 1 升 QuestionSplitOCR；StructureTask；TaggingTask；import 走 q+a+j+(m)；SessionSummary；metadata.structure (含 coords) |
| Sub 5 data export | 🚧 PR #24 | schema_version 1.0；各 lock'd schema 落实后 bump 1.1 |

---

## 重排 Phase 1b/2 plan

| 新 # | Sub | 必先决 | 估时 | 备注 |
|---|---|---|---|---|
| **Sub 0** | **Stack Migration** | 即刻 | ~5d | **挡所有 Phase 1b**；Vercel + Neon + Workflow + Cron + R2 client + Tencent OCR 升级 |
| **Sub 1** | Capture Pipeline Rebuild | Sub 0 | ~7d | 接 Q1/Q2/Q3 全栈：QuestionSplitOCR + StructureTask + Tagging + Workflow Judge + MistakeEnroll + SessionSummary + metadata.structure |
| **Sub 2** | 多学科 + knowledge_link | Sub 1 | ~3d | Q7：subject 根节点 + tree migration + knowledge_link CRUD |
| **Sub 3** | Quiz Render UI | Sub 1 | ~3d | kind-switched render + reading parent + image render + assets/:id/blob |
| **Sub 4** | StudyLog | 无强依赖 | ~2d | 最小 CRUD |
| **Sub 5** | Variants gen (Maintenance lane) | Sub 1+3 | ~4d | weekly cron batch |
| **Sub 6** | Source layer (Exa) | Sub 3 | ~3d | quiz 拿外部题源 |
| **Sub 7** | Orchestrator Agent | Sub 1-6 多数 | ~7d | Layer 2; agent_session + multi-turn |
| **Sub 8** | Dreaming lane (daily cron) | Sub 1+2 | ~4d | DreamingProposeTask + MasteryAdjustTask + log |
| **Sub 9** | Maintenance lane (weekly cron) | Sub 5 | ~3d | MaintenanceReviewTask + VariantsGen batch |

**总估时**：~41d (±30%)。

---

## 不变量 / 全局原则

1. **LLM 是核心战略**；OCR 这种 deterministic 任务靠成熟服务（Tencent / vision LLM 兜底）
2. **所有题入库**（不止错题）；mistake = AI 决策的 enroll 子集
3. **所有 LLM 决策必带 audit log**（tool_call_log + 任务专属 log 如 mastery_adjustment_log）
4. **Schema 一等列优先于 metadata JSON 软链**（subject / session_id / domain）
5. **每 op 必属 4 lane 之一**（sync user-facing / async Workflow / cron / user-triggered）
6. **用户始终可覆盖 AI**（改判 / 手加 mistake / 编辑 knowledge_ids / 回滚 mastery_adjustment）
7. **跨 subject 通过 question.knowledge_ids 多挂；科内通过 knowledge_link**

---

## 待办（review 输出后）

1. 把此 spec 加到 PLANNING.md 的 reference 列表
2. 更新 PLANNING.md 的 Phase 1b/2 路线图为新 sub 顺序
3. PR #24 (Sub 5) merge 后单开 Sub 0 Stack Migration brainstorm + spec + plan
4. Sub 4C 已 ship 部分（OCR cascade）的 EduPaperOCR → QuestionSplitOCR 升级当作 Sub 0 子任务顺手做
5. 已 ship 的 mistakes 数据迁移策略（如果有真实使用数据）— 否则丢弃 fixture 数据从 0 开始
