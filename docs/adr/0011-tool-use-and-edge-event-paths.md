# Tool-use + suggestion + knowledge_edge 事件路径追认（extends ADR-0006 v2）

> 起源：v2.1 design brief (2026-05-15) 引入 AI tool-use 三段式 UI 与 chip 直触发 tool 流；ADR-0010 (2026-05-15) 引入 knowledge_edge × 3 路径。这些路径已被 design / ADR 引用，但未在 ADR-0006 v2 的 `KnownEvent` discriminated union 里有 schema 定义。本 ADR 追认 5 处新 event 路径，**让 design 与 ADR 不再漂移**。
>
> **Revisions**
> - **v2 (2026-05-16)**：§2 AcceptSuggestionChip.payload 加 `suggestion_kind: 'proactive' | 'corrective'` discriminator。处理 v2.1 design bundle README hot-spot #5（soft-fail corrective chip 语义混淆）。详见 §2.1。
> - v1 (2026-05-15)：5 路径首次追认。

---

## 决策

把以下 5 个 event 路径加入 ADR-0006 v2 `KnownEvent` discriminated union 的稳定区——除 `tool_use` 暂停在 `experimental:` 命名空间外，其余 4 个直接 promote 进 KnownEvent。

| # | action | subject_kind | actor | 命名空间 | 来源 |
|---|---|---|---|---|---|
| 1 | `experimental:tool_use` | `query` | agent | experimental（待稳） | v2.1 brief §1.6 |
| 2 | `accept_suggestion` | `chip` | user | stable | v2.1 brief §1.6.3b |
| 3 | `propose` | `knowledge_edge` | agent | stable | ADR-0010 + v2.1 §2.2 |
| 4 | `generate` | `knowledge_edge` | agent (maintenance / 用户授权) | stable | ADR-0010 |
| 5 | `rate` | `knowledge_edge` | user | stable | ADR-0010 + v2.1 §2.3.c |

---

## 1. ToolUseQuery — experimental（待稳）

**为什么 experimental**：v2.1 brief §1.6 引入。Copilot tool-use 是 sub-0d 落地前的设计预览；实装时可能调整 payload 形态。先用 `experimental:` 名跑稳，再 promote。

```ts
const ToolUseExperimental = z.object({
  actor_kind: z.literal('agent'),
  actor_ref: z.string(),                      // 'copilot' | task_kind
  action: z.literal('experimental:tool_use'),
  subject_kind: z.literal('query'),
  subject_id: z.string(),                     // synthetic: 'tool_use_<cuid>' 自标识
  outcome: z.enum(['success', 'failure']),
  payload: z.object({
    tool_name: z.string(),                    // 'query_mistakes' | 'query_events' | ...
    args: z.record(z.string(), z.unknown()),  // tool input parameters
    result_summary: z.string().optional(),    // human-readable: "3 events found"
    result_count: z.number().int().optional(),
    error_reason: z.string().optional(),      // outcome='failure' 时填 (timeout / rate_limit / parse_error)
  }),
  // caused_by_event_id 指向触发它的 user ask / accept_suggestion event
});
```

**Stabilization criteria** —— 满足后 promote 为 `ToolUseQuery`（去 `experimental:` 前缀）：

- 至少 3 个 tool 真实落地（query_mistakes / query_knowledge / query_events 三选一够）
- payload shape 稳定 2 周无修改
- v2.1 design 已实装且没改 args 结构
- 跟 cost_ledger 的关系定下来（cost_micro_usd 是直接写本 event 还是只在 cost_ledger 双写）

**晋升路径**：写 promotion PR，含 (a) Zod schema 改名 (b) `UPDATE event SET action='tool_use' WHERE action='experimental:tool_use'` 迁移 (c) ADR-0011 修订段记录。

---

## 2. AcceptSuggestionChip — stable

**为什么 stable**：v2.1 designer 反馈采纳——chip 不模拟 user msg，而是写 first-class 事件。语义已稳：用户接受 agent 提议的结构化动作。

```ts
const AcceptSuggestionChip = z.object({
  actor_kind: z.literal('user'),
  actor_ref: z.literal('self'),               // 单用户（ADR-0007）
  action: z.literal('accept_suggestion'),
  subject_kind: z.literal('chip'),
  subject_id: z.string(),                     // synthetic chip id from agent payload
  outcome: z.literal('success'),
  payload: z.object({
    chip_label: z.string(),                   // "出 3 道变式" / "归因 e_20" / "扩到 90 天再查"
    suggestion_kind: z.enum(['proactive', 'corrective']),  // ★ v2 — see §2.1
    target_tool: z.string().optional(),       // 'propose_variant' / 'attribute_mistake' / ...
    target_args: z.record(z.string(), z.unknown()).optional(),
    source_event_id: z.string(),              // agent 上一条 explain event 的 id（chip 出自这里）
  }),
  // caused_by_event_id = source_event_id（chip 是来自 agent 提议）
});
```

### 2.1 `suggestion_kind` discriminator — 处理 v2.1 hot-spot #5

v2.1 designer 在 README hot-spot #5 push back：soft-fail 时 corrective chip（如 "扩到 90 天再查"）用 `accept_suggestion` 语义不准——主动提议（"出 3 道变式"）和修正建议（"换个查询参数再试"）在意图上不同。

**决策**：复用同一 `accept_suggestion` action（不增 action），payload 加 `suggestion_kind` 二级判别。两种含义：

| `suggestion_kind` | 上下文 | 例子 | source_event 形态 |
|---|---|---|---|
| `proactive` | agent 在成功 explain 后主动提议下一步动作 | "出 3 道变式" / "归因这道题" | source = `explain` event，outcome=success |
| `corrective` | agent 在失败 / 0 result 后提议修正参数 | "扩到 90 天再查" / "改用 query_events 看所有 attempts" | source = `tool_use` event，outcome=failure 或 result_count=0 |

**两者共享**：写 first-class event，UI 渲染为 chip-tag row（不伪装 user msg），caused_by 指向 source。

**两者区分**：handler 层可按 `suggestion_kind` 分支——`corrective` 不计入"用户接受 AI 建议"KPI（避免修正动作虚增接受率），UI 上可加 "修正" 标签。

**为何不新开 action**：
- chip 主体语义"用户从 agent 提议里挑了一个动作"在两种情况下一致
- discriminated union 多一个分支增加 Zod 表面积，而 payload 字段拓展是 ADR-0006 v2 鼓励的渐进演化
- 真有第三种 chip 语义（如 "纠正 AI 错误"）再考虑分裂

**stabilization**：v2.1 design 已实装两种 chip。1c.2 实装时 SEED 至少各 1 个 `proactive` + `corrective` 用例。

**事件链典型形态**（v2.1 §1.6.3b）：

```
e1 user.ask                    → "现在有哪些错题"
e2 agent.tool_use(query_mistakes) caused_by=e1
e3 agent.explain               → "找到 3 道，[chip: 出变式] [chip: 归因] ..."
                                 caused_by=e2
e4 user.accept_suggestion(chip='出变式', target_tool='propose_variant')
                                 caused_by=e3
e5 agent.tool_use(propose_variant) caused_by=e4
```

注意：e4 中 `caused_by=e3` 表"chip 出自 e3 的提议"。UI 上 e4 渲染为小 chip-tag row（不画 user ask bubble）。

---

## 3. ProposeKnowledgeEdge — stable

ADR-0010 §"AI 平等 actor 在 mesh 上的体现" 已规定。本 ADR 给 Zod schema：

```ts
const ProposeKnowledgeEdge = z.object({
  actor_kind: z.literal('agent'),
  actor_ref: z.string(),                      // 'review' | 'dreaming' | task_kind
  action: z.literal('propose'),
  subject_kind: z.literal('knowledge_edge'),
  subject_id: z.string(),                     // 'kedge_pending_<cuid>'（待用户 accept 后才落 knowledge_edge 表）
  outcome: z.enum(['success', 'partial']),
  payload: z.object({
    from_knowledge_id: z.string(),
    to_knowledge_id: z.string(),
    relation_type: z.enum([
      'prerequisite', 'related_to', 'contrasts_with', 'applied_in', 'derived_from',
    ]).or(z.string().refine((s) => s.startsWith('experimental:'))),
    weight: z.number().min(0).max(1).default(1),
    reasoning: z.string(),                    // 必填——AI 解释为啥提议
  }),
});
```

**Mesh 不变量（数据假设清单 §C 同步）**：propose 时若 `from→to` 已是 tree parent_id 关系，agent 应拒绝（"mesh 不存 tree 已表达的边"）。这条 invariant 在 propose handler 前置 guard 里强制；Zod schema 不直接表达（需要查 knowledge 表）。

---

## 4. GenerateKnowledgeEdge — stable

ADR-0010：maintenance agent / 用户授权时直接落库一条 edge（跳 user accept）。Zod：

```ts
const GenerateKnowledgeEdge = z.object({
  actor_kind: z.enum(['agent', 'user']),      // 'user' 用于用户手加边
  actor_ref: z.string(),
  action: z.literal('generate'),
  subject_kind: z.literal('knowledge_edge'),
  subject_id: z.string(),                     // 真 knowledge_edge.id（已落库）
  outcome: z.enum(['success', 'failure']),
  payload: z.object({
    from_knowledge_id: z.string(),
    to_knowledge_id: z.string(),
    relation_type: z.enum([
      'prerequisite', 'related_to', 'contrasts_with', 'applied_in', 'derived_from',
    ]).or(z.string().refine((s) => s.startsWith('experimental:'))),
    weight: z.number().min(0).max(1).default(1),
    reasoning: z.string().optional(),         // user 加时可省；agent 加必填
    propose_event_id: z.string().optional(),  // 若是从 propose 晋升的，引用源 propose event
  }),
});
```

---

## 5. RateKnowledgeEdge — stable

ADR-0010：用户对 AI 提议的 edge 投票 accept/dismiss/reverse/change_type。Zod：

```ts
const RateKnowledgeEdge = z.object({
  actor_kind: z.literal('user'),
  actor_ref: z.literal('self'),
  action: z.literal('rate'),
  subject_kind: z.literal('knowledge_edge'),
  subject_id: z.string(),                     // 指向 propose event 或已存在的 knowledge_edge
  outcome: z.literal('success'),
  payload: z.object({
    rating: z.enum(['accept', 'dismiss', 'reverse', 'change_type', 'rollback']),
    new_relation_type: z.string().optional(), // rating='change_type' 时必填
    new_direction_reversed: z.boolean().optional(), // rating='reverse' 时
    user_note: z.string().optional(),
  }),
  // caused_by_event_id = 被评价的 propose / generate event
});
```

`accept` → 触发 `generate` event 落库 edge（在 handler 链上）。
`dismiss` → propose event 状态变 dismissed，但 propose event 自身不删（保留审计）。
`reverse` / `change_type` → 触发新 `generate` event with 反向 / 改类型 edge。
`rollback` → 仅 30d 内可用，撤销已 generate 的 edge（写 archived_at）。

---

## 完整 KnownEvent union 扩展（修订 ADR-0006 v2 §payload 守护策略）

```ts
const KnownEvent = z.discriminatedUnion('action', [
  AttemptOnQuestion,
  JudgeOnEvent,
  ReviewOnQuestion,
  ProposeKnowledge,
  ProposeKnowledgeEdge,      // ★ new
  GenerateArtifact,
  GenerateKnowledgeEdge,     // ★ new
  RateEvent,
  RateKnowledgeEdge,         // ★ new
  AcceptSuggestionChip,      // ★ new
  ExtractSourceDocument,
]);

const ExperimentalEvent = z.object({
  action: z.string().refine((s) => s.startsWith('experimental:')),
  payload: z.record(z.string(), z.unknown()),
});

export const Event = z.union([KnownEvent, ExperimentalEvent]);
// ToolUseExperimental 走 ExperimentalEvent 路径（不在 KnownEvent 里）
```

`action` 区分新分支用 `subject_kind` 作 secondary discriminator——Zod discriminatedUnion 不支持多键，但每个 schema 已用 `z.literal()` 锁住 subject_kind，所以 parse 时仍可单义解析。

---

## 与现有 ADR 关系

- **ADR-0006 v2** —— 本 ADR 是它的 ★ extension。本 ADR 落地需要 ADR-0006 v2 已落（events 表存在）。
- **ADR-0010** —— 本 ADR 给 ADR-0010 提到的 3 个 edge event 路径写正式 Zod schema。
- **ADR-0007**（单用户） —— `actor_ref='self'` 在 user 事件上固定，符合 single-user 假设。
- **ADR-0004**（Pattern C 两类 agent） —— ToolUseExperimental 服务的是 User Copilot（Pattern C），稳定后晋升时可能拆出多个 actor_ref（agent:copilot / agent:dreaming / ...）。

---

## 落地步骤

落入 Phase 1c.1 Step 2（per-action × subject_kind Zod schemas）：

1. `src/core/schema/event.ts` 加 5 个新 schema + 改 `KnownEvent` union
2. 单元测试：每个新 schema 至少 1 个 valid parse + 1 个 invalid parse 测试
3. `src/server/events/writer.ts` —— 当前实现 `writeJobEvent()` 只写 `job_events` 表（pg-boss SSE plumbing，per Sub 0c），**不**写 domain `event` 表（该表 Phase 1c.1 Step 1 才创建）。Step 1 后需在此模块新增 `writeDomainEvent()`（或 polymorphic 入口），覆盖 KnownEvent union 各分支
4. handler 层：
   - `propose_knowledge_edge` handler（dreaming agent 调用）
   - `accept_edge_proposal` handler（接 user rate=accept → 生成 generate event + 落 knowledge_edge 表）
   - tool_use 写入由 AI runner / Copilot 路径调用，sub-0d 落地

---

## 触发重新评估

- `experimental:tool_use` 落地 2 周后稳定，则按本 ADR §1 stabilization criteria promote
- 若 v2.1 design 第二轮 designer 引入新 event 路径（如 dwell-with-no-progress signal、新 chip 形态），开 ADR-0011 修订段或 ADR-0012 追加
- mesh edge invariant（"不存 tree 已有边"）若在 Zod 之外用代码 guard 后仍有 leak，考虑 PG check constraint 或 schema 层加运行时 verify
