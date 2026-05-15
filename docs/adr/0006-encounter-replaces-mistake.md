# Event-driven 核 — AI 与用户结构对等

> **Revision history**
> - **v2 (2026-05-15)** ⬇ 当前版本。从单表 encounter + per-outcome evidence 转向 3-table 模型（material + learning_session + event）。背景：用户明确 AI-Driven（C+D 档）是中心设计概念，单表是 AI-light（A 档）架构，无法承载"AI 是平等 actor / AI 主动产出 / Copilot 对话"。
> - ~~v1 (2026-05-14)~~ — encounter 单表 + per-outcome evidence jsonb。**superseded**：参见本文档底部 "v1 决策（已被取代）" 节。

---

## 决策（v2）

把"用户与材料的每一次交互"从单一 `encounter` 表，**重构为 3-table 核**：

```
[material]                 → 已有 4 表（question / knowledge / source_document / artifact）
                             artifact 表"激活"，从 dead schema 变为 AI 主要产出落点
[learning_session]         → ADR-0008 已规划的多 type session 容器
[event]   ★ NEW ★          → 统一 action log，user 与 agent 结构对等
```

加一张 FSRS 状态投影表：

```
[material_fsrs_state]   → 从 event 流派生的最新 FSRS 状态
```

**DROP** 三张表（迁移到 event）：

- `mistake` → `event WHERE action='attempt' AND outcome='failure' AND subject_kind='question'`
- `review_event` → `event WHERE action='review' AND subject_kind='question'`
- `dreaming_proposal` → `event WHERE action='propose' AND actor_kind='agent'`

**保留**：

- `learning_item` —— 用户 / AI 声明的学习意图（TODO / Goal 层），与 event 解耦不同语义
- `cost_ledger` / `tool_call_log` —— per-step AI 账本，比 event 更细粒度
- `job_events`（Sub 0c）—— pg-boss 状态机的 plumbing 事件流，与领域 event 不同关注点

---

## event 表 schema

```sql
event {
  id: text PK
  session_id: text NULLABLE  → learning_session.id    -- cron/system 事件可空
  actor_kind: text NOT NULL    -- 'user' | 'agent' | 'cron' | 'system'
  actor_ref: text NOT NULL     -- 'self' (单用户) / task_kind (agent) / cron_name
  action: text NOT NULL        -- 'attempt' | 'judge' | 'propose' | 'generate' | 'review' | 'rate' | 'extract' | 'import' | ...
  subject_kind: text NOT NULL  -- 'question' | 'knowledge' | 'knowledge_edge' | 'artifact'
                                --  | 'source_document' | 'event' (chain)
                                -- 注：'knowledge_edge' 加于 ADR-0010 (mesh)
  subject_id: text NOT NULL
  outcome: text NULLABLE       -- 'success' | 'failure' | 'partial' | NULL（视 action 而定）
  payload: jsonb NOT NULL      -- Zod-guarded per action × subject_kind 组合（见下）
  caused_by_event_id: text NULLABLE  -- 链接：judge ← attempt，propose ← cron 等
  task_run_id: text NULLABLE   -- AI 事件关联 ai_task_runs
  cost_micro_usd: integer NULLABLE  -- 直接成本（与 cost_ledger 双写或择一）
  created_at: timestamp NOT NULL
}

-- 主索引（高频查询）
index event_subject_idx on (subject_kind, subject_id, created_at desc)
index event_action_outcome_idx on (action, outcome, created_at desc)
index event_session_idx on (session_id, created_at)
index event_actor_idx on (actor_kind, actor_ref, created_at)
```

---

## payload 守护策略 = "Option 折中"

**核心 6+ 组合 Zod 严守 discriminated union**：

```ts
// src/core/schema/event.ts

const AttemptOnQuestion = z.object({
  actor_kind: z.enum(['user', 'agent']),
  action: z.literal('attempt'),
  subject_kind: z.literal('question'),
  outcome: z.enum(['success', 'failure', 'partial']),
  payload: z.object({
    answer_md: z.string().nullable(),
    answer_image_refs: z.array(z.string()),
    duration_ms: z.number().int().optional(),
  }),
});

const JudgeOnEvent = z.object({
  actor_kind: z.literal('agent'),
  action: z.literal('judge'),
  subject_kind: z.literal('event'),
  outcome: z.literal('success'),
  payload: z.object({
    cause: CauseSchema,                     // 10 类 enum + analysis_md + confidence
    referenced_knowledge_ids: z.array(z.string()),
  }),
});

const ReviewOnQuestion = z.object({
  actor_kind: z.literal('user'),
  action: z.literal('review'),
  subject_kind: z.literal('question'),
  outcome: z.enum(['success', 'failure']),
  payload: z.object({
    fsrs_rating: z.enum(['again', 'hard', 'good']),
    fsrs_state_after: FsrsStateSchema,
    user_response_md: z.string().nullable(),
  }),
});

const ProposeKnowledge = z.object({
  actor_kind: z.literal('agent'),
  action: z.literal('propose'),
  subject_kind: z.literal('knowledge'),
  outcome: z.enum(['success', 'partial']),
  payload: z.object({
    name: z.string(),
    parent_id: z.string(),
    reasoning: z.string(),
  }),
});

const GenerateArtifact = z.object({
  actor_kind: z.literal('agent'),
  action: z.literal('generate'),
  subject_kind: z.literal('artifact'),
  outcome: z.enum(['success', 'failure']),
  payload: z.object({
    artifact_kind: z.enum(['note', 'quiz', 'variant', 'summary']),
    title: z.string(),
    body_md: z.string(),
    referenced_event_ids: z.array(z.string()).optional(),
  }),
});

const RateEvent = z.object({
  actor_kind: z.literal('user'),
  action: z.literal('rate'),
  subject_kind: z.literal('event'),
  outcome: z.enum(['success']),
  payload: z.object({
    rating: z.enum(['accept', 'dismiss', 'rollback']),
    user_note: z.string().optional(),
  }),
});

// Tencent OCR 抽取也是 event（替代 ingestion_session 单独管）
const ExtractSourceDocument = z.object({
  actor_kind: z.literal('agent'),
  action: z.literal('extract'),
  subject_kind: z.literal('source_document'),
  outcome: z.enum(['success', 'partial', 'failure']),
  payload: z.object({
    structured_block_ids: z.array(z.string()),  // 关联 question_block
    layout_quality: z.enum(['structured', 'partial', 'text_only']),
    warnings: z.array(z.string()),
  }),
});

const KnownEvent = z.discriminatedUnion('action', [
  AttemptOnQuestion,
  JudgeOnEvent,
  ReviewOnQuestion,
  ProposeKnowledge,
  GenerateArtifact,
  RateEvent,
  ExtractSourceDocument,
]);

// 实验性 escape hatch
const ExperimentalEvent = z.object({
  action: z.string().refine((s) => s.startsWith('experimental:')),
  payload: z.record(z.string(), z.unknown()),
});

export const Event = z.union([KnownEvent, ExperimentalEvent]);
```

**所有 event 写入必须经 `Event.parse(...)`**。

新 action 探索流程：
1. 用 `experimental:<name>` 命名空间先写
2. 稳定后 promote 到 KnownEvent（写 Zod schema + 测试覆盖）+ 数据迁移（`experimental:foo` → `foo`）

---

## 三个 C+D 场景的事件流（验证模型）

### 场景 1：用户拍试卷错答 + AI 全套自动后处理

```
events (5 行链式):
  e1: actor=user / action=attempt / subject=question:q1 / outcome=failure
      payload={answer_md:"代词指代", answer_image_refs:["asset_..."]}
  e2: actor=agent:attribution / action=judge / subject=event:e1 / outcome=success
      payload={cause:{primary:'concept', confidence:0.87, ai_analysis_md:"..."}}
      caused_by=e1, task_run_id=t1
  e3: actor=agent:propose / action=propose / subject=knowledge:k_xuci_zhi(new) / outcome=success
      payload={name:"之-定语标志", parent_id:"k_xuci", reasoning:"..."}
      caused_by=e1, task_run_id=t2
  e4: actor=agent:variant_gen / action=generate / subject=artifact:a1(new) / outcome=success
      payload={artifact_kind:'variant', title:"变式 1", body_md:"...", referenced_event_ids:[e1]}
      caused_by=e1, task_run_id=t3
  e5: actor=user / action=rate / subject=event:e3 / outcome=success
      payload={rating:'accept'}  -- 用户接受 AI 提议的知识点
```

UI 查询：
- "错题列表" = `events WHERE action='attempt' AND outcome='failure' AND subject_kind='question'`
- "近 24h AI 提议" = `events WHERE action='propose' AND actor_kind='agent' AND created_at > now()-24h`
- "事件链" = 沿 `caused_by_event_id` 递归

### 场景 2：用户和 Copilot 聊文言虚词（D 档对话）

```
learning_session(type='conversation', id=s1):
  e1: actor=user / action=attempt / subject=question:q1 / outcome=failure -- 复习答错
  e2: actor=user / action=experimental:ask_copilot / subject=event:e1
      payload={text:"为什么这里 之 是定语标志？"}
  e3: actor=agent:copilot / action=experimental:explain / subject=event:e2 / outcome=success
      payload={text_md:"...", referenced_knowledge_ids:["k_xuci_zhi"]}
      caused_by=e2
  e4: actor=agent:copilot / action=generate / subject=artifact:a_note(new) / outcome=success
      payload={artifact_kind:'note', title:"之-用法小结", body_md:"..."}
      caused_by=e3
  e5: actor=user / action=rate / subject=event:e4 / outcome=success
      payload={rating:'accept'}  -- 收藏笔记
```

注意 `experimental:ask_copilot` / `experimental:explain` —— Copilot 交互 action 还在探索期，先用 experimental 命名空间，3 个月后 promote。

### 场景 3：夜间 Dreaming agent（C 档主动产出）

```
learning_session(type='ingestion', id=s_dream):
  e1: actor=cron / action=experimental:trigger_dreaming_scan / subject=session:s_dream
  e2: actor=agent:dreaming / action=experimental:scan / subject=knowledge:k_xuci_zhi
      caused_by=e1, task_run_id=t10
  e3: actor=agent:variant_gen / action=generate / subject=artifact:a_v1(new) / outcome=success
      caused_by=e2, task_run_id=t11
  e4: actor=agent:variant_gen / action=generate / subject=artifact:a_v2(new) / outcome=success
      caused_by=e2, task_run_id=t12
  e5: actor=agent:critique / action=experimental:critique / subject=event:e3 / outcome=failure
      payload={reason:"variant too similar to source"}
      caused_by=e3, task_run_id=t13
  e6: actor=agent:dreaming / action=propose / subject=artifact:a_v2 / outcome=success
      payload={...}, caused_by=e2  -- 提议把 a_v2 收入用户复习队列
```

---

## 理由

1. **AI-Driven (C+D 档) 是中心设计概念**——AI 不是注释层，是主动 actor：变式、笔记、提议、对话、批改皆 first-class 产出。单表 encounter + per-outcome evidence 是为 A 档（"AI 在旁打 cause"）设计的，无法承载 C+D。
2. **事件流是 AI 行为的原生表达**：每个 task_run、每次 propose、每个 Copilot 回复都自然是一行 event。`/api/_/logs/jobs` 已经在 task 级做这件事——event 是它的领域语义层升级。
3. **payload 严守 = AI contract 边界**。LLM prompt 输出 JSON → Zod parse → 写入。Zod schema **同时是 prompt 文档 + 数据库守门**。AI 漂移 / 误填字段会在写入时挡住。
4. **事件链可重放 / 可审计 / 可批评**：用户可以查"AI 为什么提议这个？"沿 `caused_by_event_id` 看完整 reasoning trail。Phase 2 的 critique agent 可直接作用在 event 上。
5. **3 表比 N 表干净**：mistake / review_event / dreaming_proposal / 未来的 agent_message 等都是"某种事件"。统一成 event + actor 维度区分，比每加一种交互就建一张表干净 N 倍。

---

## 接受的代价

- **Phase 1c.1 工时 10-14d → 18-24d**。多出的 8-10d 主要在 Zod 6 schema 设计 + per-(action, subject_kind) 测试覆盖 + 三表 → event 数据迁移。用户已 ack（grill Q4）。
- **payload 是 jsonb 不是关系字段**——查询 `WHERE event.payload->>'cause'` 比 `WHERE mistake.cause IS NOT NULL` 啰嗦。**缓解**：高频查询路径加 GIN index on `payload`；为 cause / fsrs_rating 等特别热点字段可冗余 promote 为顶级列（Phase 2 优化）。
- **DROP 旧表**——`mistake` / `review_event` / `dreaming_proposal` 的数据全量迁移到 event，旧表数据不保留兼容视图（用户已 ack DROP）。**回滚**：drizzle migration 反向能恢复表结构，但要从 event 反向投影数据。
- **FSRS 投影表的写入一致性**——每次 `action='review'` 必须同事务写 `material_fsrs_state`。**缓解**：用 LearningSession 模块（ADR-0005 / ADR-0008）封装写入路径，single-owner invariant 在 event + projection 间维持。
- **新 action 演化两步走**——experimental 阶段类型不安全。**缓解**：experimental 命名空间硬 prefix 强制，每 quarter review 一次，promote 该 promote 的。

---

## 触发重新评估的条件

- **payload jsonb 查询性能瓶颈**：单 jsonb GIN 不够 → 把热点字段（cause / fsrs_rating / outcome）promote 为顶级冗余列
- **experimental:* 超过 6 种**：说明应该 promote batch + cleanup
- **多用户来临**：event 表需要加 `user_id`；改 schema + migration（ADR-0007 已承担此成本）
- **event 行数 > 100M**：性能调优 + 历史分区（pg native partitioning）
- **AI 输出 Zod parse 失败率 > 5%**：表示 Zod schema 过紧或 prompt 不稳定——回头收紧 prompt 或 widen Zod

---

## 与其它 ADR 的关系

- **ADR-0002**（抽取层 = 确定性 OCR）：`action='extract'` event 是 Tencent Mark Agent 输出的归宿；evidence.extraction_evidence 概念保留为 question_block.structured（不变）
- **ADR-0004**（Pattern C 两类 agent）：Copilot 对话**不再需要独立 agent_sessions / agent_messages 表**——learning_session(type='conversation') + event 替代。Backend Purpose Agent 仍按 ADR-0004 写法跑，每次 run 写 task_run + 关联 event(action='generate'|'judge'|'propose')
- **ADR-0005**（IngestionSession single-owner）：演化为更广的 `LearningSession` 多态模块，event 写入也走它（保 single-owner invariant 在 event 表上）
- **ADR-0008**（LearningSession 多 type envelope）：**修订**——agent_sessions / agent_messages 被吸收进 learning_session(type='conversation') + event；下次启动 Sub 0d 时按此 refresh
- **ADR-0010**（knowledge mesh）：**扩展**——event.subject_kind 加 'knowledge_edge'；新增 3 个 discriminated union 分支（Propose / Generate / Rate edge）
- **CONTEXT.md** "录入会话 / 错题 / 归因 / 学习项 / 知识点" 词条——event 时代下"错题"是 events 的视图、"归因"是 action='judge' event；逻辑保留、机制下沉

---

## v1 决策（已被取代 — 2026-05-14）

> ⚠️ 本节为历史记录。当前实现按 v2。

v1 决策：建立 `encounter` 表，单表 + 6 类 outcome（wrong / right / exposed / created / drilled / reviewed）+ per-outcome evidence jsonb。

为什么被取代：

1. 单表把"交互类型 + 结果"压成单 enum，三轴信息（interaction_type × outcome × trigger）丢失（2026-05-15 grill Q-G1）。
2. AI 在 v1 模型里是注释层（A 档）—— C 档"AI 主动产出"和 D 档"AI 对话伙伴"无法表达。
3. exposed outcome 的粒度问题（每段滚动一行 vs 整 source 一行）（2026-05-15 grill Q-G3）。
4. drilled vs reviewed 语义重叠（都是"再练一次"）（grill 同处）。
5. 中文命名"遭遇"语感差——v2 中文用"事件"（grill Q-G2）。

v1 的良好部分继承到 v2：
- evidence jsonb per-outcome Zod 守护 → v2 演化为 event.payload per-(action, subject_kind) discriminated union
- 中文 "错题 / 归因 / 复习" 等用户语义不变，code 层 entity 名换成 event
