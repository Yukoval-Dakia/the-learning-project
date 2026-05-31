# Tool-use + suggestion + knowledge_edge 事件路径追认（extends ADR-0006 v2）

> 起源：v2.1 design brief (2026-05-15) 引入 AI tool-use 三段式 UI 与 chip 直触发 tool 流；ADR-0010 (2026-05-15) 引入 knowledge_edge × 3 路径。这些路径已被 design / ADR 引用，但未在 ADR-0006 v2 的 `KnownEvent` discriminated union 里有 schema 定义。本 ADR 追认 5 处新 event 路径，**让 design 与 ADR 不再漂移**。
>
> **Revisions**
> - **erratum (2026-05-31, P5.6 / YUK-178)**：§2.1 的 `suggestion_kind` discriminator 与 "corrective 不计入接受率" KPI 后果在 v2 里只有 *意图*，没有 handler / write path / KPI choke point，且 `AcceptSuggestionChip` 从未被任何代码写过。P5.6 是 operationalizing erratum——见文末 §11。
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

## 1.1 Promotion record（T-D7 / YUK-126, 2026-05-28）

`ToolUseExperimental` 已 promote 为 KnownEvent `ToolUseQuery`（去 `experimental:` 前缀），shape 完全保留 §1 中的形态。Promotion PR: Wave 6 Lane B（branch `yuk-TD7-tool-use-promote`）。

**实施 diff（6 步）**

1. `src/core/schema/event/known.ts` 新增 `ToolUseQuery`，`action: z.literal('tool_use')`，subject_kind='query'，payload `{ tool_name, args, result_summary?, result_count?, error_reason? }` 与原 ToolUseExperimental 完全相同。加入 `KnownEvent` z.union（第 14 个分支）。
2. `src/core/schema/event/experimental.ts`：删除 `ToolUseExperimental` 与 `ToolUseExperimentalT` 导出，从 `RESERVED_EXPERIMENTAL_ACTIONS` 移除 `'experimental:tool_use'`，更新 generic `ExperimentalEvent` refine error 中的 reserved-action 例子。
3. `src/core/schema/event/index.ts`：移除 ToolUseExperimental 的 top-level import 与 union 分支，KnownEvent 现在包含 ToolUseQuery；顶部 union 注释更新到 14 个分支。
4. `drizzle/0019_promote_tool_use.sql`（DML-only，手写）：`UPDATE "event" SET "action" = 'tool_use' WHERE "action" = 'experimental:tool_use'`。无 DDL 变更，event table 列结构不动；meta/_journal.json 新增 idx=19 条目。
5. `src/server/ai/tools/mcp-bridge.ts`：mirror writer 的 `action: 'experimental:tool_use'` → `'tool_use'`；`__resolveMirrorPolicy` docstring + 文件 banner + console.error label 一并更新。`src/server/ai/tools/types.ts` 中 `mirrorEvent` policy 注释指向新 action 名。
6. Consumer sweep：`tests/schema/event.test.ts`（import + describe + 5 个 it + 3 个 top-level Event it 全部 rename 到 `ToolUseQuery` / `action: 'tool_use'`，并改原"rejects reserved action 'experimental:tool_use'"测试为 `experimental:user_cause`，因后者仍在 RESERVED 集合中），`src/server/ai/tools/mcp-bridge.test.ts`、`src/server/ai/tools/mcp-bridge.integration.test.ts`、`src/server/memory/scope_tagger.test.ts`、`src/server/events/queries.test.ts`、`src/ai/README.md` 同步。

**Stabilization 证据**

12 天（接近但未满 14 天临界，需 user-override 豁免，见下）
- 3+ tool 真实落地：Wave 2/3 已交付 13+ read tools + 8 propose/write tools（见 Foundation D M2/M4），远超 ≥ 3 的 criterion。
- v2.1 design 已实装：Wave 5 T-D3 已 ship Copilot drawer + tool-use 三段式 UI（PR #179 merged 2026-05-29）。
- cost_micro_usd shape：保留原 ToolUseExperimental 中的 optional `cost_micro_usd` 字段（继承自 `baseOptionalFields`），ToolUseQuery 维持同等可选性。后续若改双写 cost_ledger 模式，另起 ADR。

**User-override note**：原 ADR-0011 §1 stabilization criteria 第二条要求"payload shape 稳定 2 周"以 Wave 5 Drawer tool-use ship 日期为基准——按原计划晋升应等到 ~2026-07-21。该 2-周 stabilization 时序 gate 由 user 2026-05-28 explicitly waive；理由是 schema shape 自 YUK-82 (2026-05-16) 至今已 12 天无修改 + ≥ 3 tool 已落地 pre-condition 仍满足，gate 实质等价已通过。**Quality gates（typecheck / lint / audit:* / test / build）均未 waive，照常执行。**

**Out of scope（deferred）**

- Wave 5 closeout drift audit (`docs/audit/2026-05-29-wave5-closeout-drift.md`) 提及的 2 个其它 experimental action —— `experimental:copilot_user_ask` 与 `experimental:copilot_chip_trigger` —— 不在本 T-D7 范围内。它们未在本 ADR §1 拥有 dedicated schema，按 generic ExperimentalEvent 走，将在后续 ADR-0011 erratum 或 Wave 7+ 独立处理。

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

---

## §11 Erratum — P5.6 operationalizes the `suggestion_kind` discriminator (2026-05-31, YUK-178)

§2.1（`:113`–`:121`）signed off 了 `suggestion_kind` discriminator + KPI 后果（"`corrective` 不计入接受率"），但 **没写 handler spec / write path / KPI choke point**，而它定义的 `AcceptSuggestionChip` event **从未被任何代码写过**（dead letterbox）。P5.6（设计 spec `docs/superpowers/specs/2026-05-31-p5.6-copilot-suggestion-semantics-design.md`）是这条的 operationalizing erratum：

1. **`suggestion_kind` 落成 `BaseProposal` 上的 OPTIONAL 字段**（`src/core/schema/proposal.ts`）+ 4 个 agent-callable propose 工具（`propose_knowledge_edge` / `propose_knowledge_mutation` / `propose_record_links` / `propose_record_promotion`）的 OPTIONAL 输入 arg，不再只挂在 `AcceptSuggestionChip` 上。discriminator 现在随 proposal payload（真正的 Coach/Copilot 输出）走。这是 Option B（显式可选字段），不是新 `accept_correction` action——§2.1 的单一 `accept_suggestion` action 决定保留。absence === `proactive`（reader `resolveSuggestionKind`）。
2. **KPI 排除有了具体 choke point**：proposal-signal 的 `accept_count`/`dismiss_count` 在它**两个**写入点都被 gate——`recordProposalDecisionSignal`（incremental，`signals.ts`）与 `rebuildProposalDecisionSignal`（replay/reconcile）；corrective 在 accept 端不计 `accept_count`、dismiss 端不计 `dismiss_count`（全排除，分子分母都不污染），但 corrective dismiss **仍写 `cooldown_until`**（gate 跳过的是计数，不是 cooldown）。§2.1 的 "不计入接受率" 现在是 incremental + reconcile 端到端机制化，不再是 aspirational。
3. **唯一确定性 corrective = `variant_question` 结构地板**：它的 producer 只在失败 attempt 后触发，hard-set `suggestion_kind:'corrective'`。其余 corrective 走 4 个 propose 工具的**显式模型标注**（model 自己判断这条 proposal 修复了它观察到的失败）。**没有** soft-fail / `result_count===0` 确定性兜底（first-draft 的那个 trigger 被 drop 了——bridge 从不 populate `result_count`，soft-fail 读取是 `outcome:'success'`，且 SDK loop per-turn stateless 无法把 turn outcome 线进 tool）。
4. **`AcceptSuggestionChip` 的 writer 由 P5.6 新增**（一个新的 `POST …/accept-chip` endpoint，见 P5.6 spec §6 / call-site 12，Lane 2）——schema 在 P5.6 前一直是 dead letterbox。§2.1 的 `source_event_id` 约定（proactive 用 `explain`、corrective 用 `tool_use`）在写入时 honored。

§2.1 的 *语义表*（proactive/corrective 定义 + source-event 形态）**不变**——P5.6 verbatim 实现它。本 erratum 纯粹是补 §2.1 缺失的 handler/write/KPI 层。**No DB migration, no new event action, no new schema table**（`suggestion_kind` 是既有 `experimental:proposal` event 上的 payload 字段 + 可选 tool input；chip-accept KPI 是 event-table reader）。
