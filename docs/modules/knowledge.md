# 知识图谱（Knowledge Graph）

> Last reviewed: 2026-05-28 (T-PD8)
>
> 见 [架构基础](../architecture.md) 的 `knowledge_mesh`、[ADR-0010](../adr/0010-knowledge-mesh.md)、[ADR-0011](../adr/0011-tool-use-and-edge-event-paths.md)。
> Mastery 见 [ADR-0012](../adr/0012-mastery-as-derived-view.md)（derived view）。
> Agent runtime tool 设计见 [Agent Context Tools Design](../superpowers/specs/2026-05-17-agent-context-tools-design.md)。

知识图谱是学习系统的解释骨架：`knowledge.parent_id` 表达主层级，`knowledge_edge` 表达有类型的横向 mesh。Agent 读图时必须读懂这两层语义，而不是只拿数据库行。

---

## 0. 实施现状（2026-05-28）

| 设计概念 | 现状 | 备注 |
|---|---|---|
| `knowledge` 表 + `parent_id` tree backbone | ✅ | root 节点带 `domain='wenyan'`；子节点继承 effective domain |
| Wenyan seed | ✅ | `src/subjects/wenyan/curriculum.json` 目前 7 个顶层 cluster：实词 / 虚词 / 句式 / 断句 / 翻译 / 文学常识 / 论述题 |
| `knowledge_edge` typed mesh | ✅ | 5 个核心 relation type + `experimental:*`；唯一约束 `(from,to,type)` |
| `knowledge_edge` 单一写入点 | ✅ | `src/server/knowledge/edges.ts` |
| edge propose event | ✅ | `event(action='propose', subject_kind='knowledge_edge')` |
| edge accept / rate path | ✅ | `RateKnowledgeEdge` → `GenerateKnowledgeEdge` → insert edge |
| `KnowledgeEdgeProposeTask` | ✅ registered | 单轮结构化输出，nightly / maintenance 用 |
| `KnowledgeReviewTask` | ✅ registered, tool-call | in-process MCP `write_proposal`；可写 tree / mesh proposal |
| Subject Graph Guide runtime | ❌ | 本文先定义 contract；实现放 agent-tools 后续 |
| Graph reader tools | ❌ | `get_subject_graph_overview` / `query_knowledge` / `expand_knowledge_subgraph` / `find_knowledge_paths` 尚未实现 |

---

## 1. 图谱语义

### 1.1 Tree backbone

`knowledge.parent_id` 是主层级，只回答“这个知识点属于哪里”。

规则：

- root 节点 `parent_id=null` 且 `domain` 非空。
- child 节点 `domain=null`，通过 ancestor 继承 effective domain。
- tree 关系不应重复存成 mesh edge，除非 edge 语义明显不同。
- tree 主要服务 UI tree-view、effective domain、Learning Intent 的 hub/atomic 拆分。

### 1.2 Mesh edges

`knowledge_edge` 是横向语义，不是目录结构。

| relation_type | 通用语义 | Wenyan 例子 | agent 注意事项 |
|---|---|---|---|
| `prerequisite` | from 是 to 的前置 | 实词词义 → 翻译 | 需要学习顺序证据；不能只因为两个节点同名相近 |
| `related_to` | 弱关联 | 断句 ↔ 翻译 | 低风险但价值也低；避免泛滥 |
| `contrasts_with` | 易混 / 对照 | 之-代词 vs 之-助词 | 需要 confusion 证据，优先来自失败 attempt |
| `applied_in` | from 被用于 to | 古今异义 → 阅读理解 | from 应是方法/概念，to 应是题型/应用场景 |
| `derived_from` | from 派生出 to | 虚词用法 → 之-主谓间用法 | 方向要解释清楚，避免和 tree parent 重复 |
| `experimental:*` | 探索期新关系 | `experimental:often_co_occurs` | 必须有明确 promotion 条件，否则不要用 |

---

## 2. Subject Graph Guide Contract

Subject Graph Guide 是给 agent 的“图例”和“读图提示”。它不是用户审批的知识事实，也不是每个学科一份手写代码。它是一个可自动 seed、可自动丰富、可版本化回滚的上下文解释层。

没有 guide 时，agent 仍可用通用图谱规则工作；有 guide 时，graph reader tools 能返回更贴合当前学习区域的 root cluster、relation hint 和 proposal guardrail。

### 2.1 生命周期

Guide 不需要用户确认后才 active。它不直接改变 `knowledge` / `knowledge_edge`，所以风险级别低于图谱 mutation。

推荐生命周期：

1. **seed**：创建新 subject 或大的学习区域时，系统用通用模板 + 当前 root nodes 自动生成 v1 guide。
2. **enrich**：随着错题、学习记录、edge accept/dismiss、node 增长，agent 定期更新 guide 的 relation hints、cluster summaries、bad-evidence patterns。
3. **observe**：每次 guide 更新写 event / revision log，记录来源和 diff 摘要。
4. **rollback**：如果某个 guide revision 明显误导 agent，可以回滚到上一版。

Guide 可以由 AI 自主生成和更新，但 guide 更新只影响“怎么读图”，不执行真实图谱 mutation。任何由 guide 推导出的 edge/node/tree 改动仍然走 proposal + accept。

### 2.2 Type shape

```ts
type RelationDirection = 'directed' | 'symmetric';

interface SubjectGraphGuide {
  id: string;
  subject_id: string;
  area_node_id?: string; // 可选：某个大知识区域的局部 guide
  displayName: string;
  version: number;
  status: 'active' | 'archived';
  createdBy: { actor_kind: 'system' | 'agent' | 'user'; actor_ref: string };
  source: 'system_seed' | 'ai_seed' | 'ai_enrichment' | 'manual_edit';
  rootClusters: Array<{
    slug: string;
    name: string;
    role: 'concept_family' | 'method' | 'application' | 'assessment';
    readingHint: string;
  }>;
  relationHints: Array<{
    type: 'prerequisite' | 'related_to' | 'contrasts_with' | 'applied_in' | 'derived_from' | `experimental:${string}`;
    direction: RelationDirection;
    meaningForSubject: string;
    goodEvidence: string[];
    badEvidence: string[];
  }>;
  proposalGuardrails: {
    requireEvidenceEventIdsForAgent: boolean;
    maxProposalsPerRun: number;
    allowRootMutationByAgent: boolean;
  };
  readingHint: string;
  updatedAt: string;
}
```

### 2.3 存储选择

短期可先用 `artifact(type='subject_graph_guide')` 或 JSON 文件 seed，但长期建议单独实体，因为 graph reader tools 会高频读取它：

```text
subject_graph_guide
  id
  subject_id
  area_node_id null
  version
  status
  guide_json
  created_by
  source
  created_at
  updated_at
```

如果不想立刻加表，先把 guide 作为 `artifact` 落地也可以，但必须保留 `version` 和 `source`，否则后续无法判断 agent 用的是哪一版读图规则。

### 2.4 Guide seed triggers

自动 seed 场景：

- 新建 subject，例如用户开始“数学 · 立体几何”。
- 某个 root / hub 节点开始承担一个独立学习区域，例如“空间角与距离”。
- Learning Intent 接受后创建了 hub + atomic 结构，但该区域没有 guide。
- 图谱增长超过阈值，例如某 root 下新增 10+ 子节点且出现 3+ failure attempts。

Seed 输入：

- 当前 root / area node 名称和 children。
- 通用 relation type 语义。
- 用户已有错题 / LearningRecord / LearningItem 标题。
- 可选教材目录或用户上传材料摘要。

Seed 输出直接 active，但带 `source='ai_seed'` 和 revision event。后续 enrichment 可以覆盖 reading hints，但不能自动改 graph。

### 2.5 Wenyan guide v1

| root cluster | role | reading hint |
|---|---|---|
| 实词 | `concept_family` | 词义、古今异义、一词多义；经常作为翻译和阅读题的前置 |
| 虚词 | `concept_family` | 用法分类多、易混度高；适合 `contrasts_with` 和细分子节点 |
| 句式 | `concept_family` | 判断句、被动句、倒装、省略等；常与翻译/断句相互影响 |
| 断句 | `method` | 解题方法型节点；常 `applied_in` 阅读和翻译 |
| 翻译 | `application` | 综合应用节点；通常依赖实词、虚词、句式 |
| 文学常识 | `concept_family` | 记忆型节点；和题目来源/作者时代有关 |
| 论述题 | `assessment` | 表达与论证任务；更像题型/输出要求，不要随意作为语法概念 parent |

Subject-level reading hint:

```text
Wenyan graph has concept families (实词/虚词/句式/文学常识), methods (断句), applications (翻译), and assessment outputs (论述题).
Tree parent_id means taxonomy. Mesh edges mean learning relation or observed confusion.
Do not propose root-level nodes in Phase 1. Prefer narrow child nodes under existing roots.
```

### 2.6 Example: solid geometry guide seed

如果用户突然开始学数学立体几何，系统应 seed 一个新的 guide，而不是要求代码里已有硬编码学科文件：

```ts
{
  subject_id: 'math_solid_geometry',
  displayName: '数学 · 立体几何',
  source: 'ai_seed',
  rootClusters: [
    { slug: 'point-line-plane', name: '空间点线面关系', role: 'concept_family' },
    { slug: 'solids', name: '几何体', role: 'concept_family' },
    { slug: 'angle-distance', name: '空间角与距离', role: 'application' },
    { slug: 'section-projection', name: '截面与投影', role: 'method' },
    { slug: 'volume-area', name: '体积与表面积', role: 'application' },
    { slug: 'proof-methods', name: '证明方法', role: 'method' },
    { slug: 'vector-method', name: '坐标/向量方法', role: 'method' },
    { slug: 'problem-types', name: '典型题型', role: 'assessment' }
  ],
  readingHint:
    'Tree parent_id means topic taxonomy. Mesh edges should capture prerequisite, confusion, and method-application relations. Prefer evidence from failed attempts before proposing edges.'
}
```

这份 guide 可自动 active；真正的 `knowledge_edge` 仍要根据后续 evidence 走 proposal。

### 2.7 Relation hints for wenyan

`prerequisite`:

- Good evidence: repeated failures in `翻译` where cause analysis points to `实词` / `虚词` / `句式`; user cannot apply a method because a prerequisite concept is missing.
- Bad evidence: two nodes are siblings; two nodes appear together in one broad prompt.

`contrasts_with`:

- Good evidence: the same user answer confuses two usages; recent failure attempts reference both nodes; judge cause says `concept` / `reading` and analysis names the distinction.
- Bad evidence: the nodes merely share a character, e.g. all `之` children.

`applied_in`:

- Good evidence: a method or concept is explicitly used to solve a question type; e.g. `词类活用` applied in `翻译`.
- Bad evidence: from/to are both concept families with no application direction.

`derived_from`:

- Good evidence: a child-ish concept is derived from a broader concept but is not already represented by tree parentage; use sparingly.
- Bad evidence: duplicating existing tree parent/child.

`related_to`:

- Good evidence: weak but useful neighborhood; low-confidence relation after stronger types do not fit.
- Bad evidence: using it as a dumping ground for uncertain proposals.

---

## 3. Graph Reader Tool Requirements

Graph reader tools must return guide-derived semantics alongside DB data.

### 3.1 `get_subject_graph_overview`

Must include:

- root clusters from `SubjectGraphGuide`
- relation type direction and subject-specific meaning
- current graph counts per root
- weak/failure counts if cheap
- one `reading_hint` string

The agent should call this before broad graph reasoning, especially Copilot and Maintenance.

### 3.2 `query_knowledge`

Must include:

- `path` from root to node
- `role` or cluster classification from the active guide
- local neighbor edges
- recent failures with short excerpts
- nullable mastery / weakness stats

It should not return the full graph unless explicitly bounded and small.

### 3.3 `expand_knowledge_subgraph`

Must include:

- center node
- ancestors / children / neighbors with roles
- relation paths with human-readable explanations
- evidence grouped by node or edge
- hard `max_nodes` cap

This is the main tool for preparing graph proposals.

### 3.4 `find_knowledge_paths`

Must explain paths directly. Do not make the model infer multi-hop relation semantics from raw edge arrays.

---

## 4. Proposal Quality Rubric

This rubric applies to agent-generated graph proposals. Manual user-created edges can be looser, but should still pass structural guards.

> **Enforcement status (Layer 1, P5.4 / YUK-143 — shipped 2026-05-31).** §4.1 / §4.2 / §4.3
> are now enforced deterministically by a single shared validator,
> `src/server/knowledge/rubric-validator.ts` (`validateProposalQuality`), called by **both**
> agent edge-proposal write paths before the propose-event write: the DomainTool
> `proposeKnowledgeEdgeExecute` and the legacy MCP `writeProposalAfterGate`. Agents are strict
> (structural + reasoning-depth + evidence floor + relation predicates); user-edited proposals run
> structural-only (§4.1 G1–G6). A rejected agent proposal is **folded, not dropped**: the propose
> event is still written carrying a `rubric_verdict: { ok:false, gate, reason }` marker, derives a
> terminal `rubric_rejected` inbox status, and is excluded from live-pending dedup/cooldown so a
> later valid proposal for the same edge is not blocked. Layer 1 is deterministic (no LLM call) and
> rejects medium/weak evidence for agents.
> Spec: `docs/superpowers/specs/2026-05-31-p5.4-rubric-enforcement-design.md`.
>
> **Enforcement status (Layer 2, P5.4-L2 / YUK-174 — shipped 2026-05-31).** The adaptive
> accept-learned bias is now live as an ADDITIVE soft layer on top of Layer 1, owned by
> `src/server/proposals/adaptive-bias.ts` (read-only). It reads `proposal_signals` (rate + recent
> dismiss reasons) and the `rubric_rejected` propose-event bucket and produces (1) a per-`(kind,
> relation)` **feedback digest** (`getProposalFeedbackDigest`) injected into the Dreaming / Coach /
> Copilot proposal prompts — each scoped to the kinds that surface can act on, so the agent learns
> the specific failure mode (the user's own dismiss reasons + the machine rubric gates) and
> self-corrects; and (2) a per-`(kind, relation)` **gate-bump** (`computeGateBump`) passed as an
> OPTIONAL 4th argument to `validateProposalQuality`. The bump is **tighten-only / never-lock**: when
> a relation's acceptance_rate is below threshold with enough samples it raises the borderline bar
> one notch (suppresses the §4.2 explicit-single-event rescue → requires genuine `strong`), but it
> NEVER loosens an L1 reject, NEVER blocks `strong` evidence, and is a no-op on cold start /
> below-`minSamples`. The validator with the 4th arg omitted is byte-identical to Layer 1, and the
> verdict shape (RB-9) is unchanged — the adaptive reject keeps `gate:'evidence_level'` and annotates
> its `reason` with the carried rate/threshold/sample for traceability. Coach also gains
> `propose_knowledge_edge` so the edge feedback is actionable. The batch
> `knowledge_edge_propose_nightly` path does not yet run Layer 1, so the gate-bump is deferred there
> to [YUK-175](https://linear.app/yukoval-studios/issue/YUK-175); the reason digest still reaches it.
> No schema change. Spec:
> `docs/superpowers/specs/2026-05-31-p5.4-l2-adaptive-bias-design.md`.

### 4.1 Universal gates

Reject before writing `event(action='propose')` when:

- `from_knowledge_id === to_knowledge_id`
- either node does not exist or is archived
- nodes are in different subjects
- exact live edge `(from,to,relation_type)` already exists
- exact pending proposal already exists
- proposal only repeats an existing tree parent/child relation
- reasoning is generic, e.g. “二者相关” with no concrete signal
- agent proposal has no `evidence_event_ids`

### 4.2 Evidence levels

| level | meaning | can write proposal? | UI treatment |
|---|---|---|---|
| strong | 2+ recent failure events show same pattern, or 1 failure plus explicit user note | yes | normal |
| medium | 1 recent failure event with clear judge analysis | yes, lower weight | show lower confidence |
| weak | name similarity, same parent, or model intuition only | no for agent proposal | ask for more evidence / skip |

Default thresholds:

- recent window: 30 days
- minimum agent evidence: 1 event for non-destructive edge proposal, 2 events for `prerequisite` / `contrasts_with` unless judge analysis is explicit
- max proposals per run: 5

### 4.3 Relation-specific gates

`prerequisite`:

- Require learning-order evidence.
- Prefer from = prerequisite concept/method, to = application or narrower task.
- Do not propose because two nodes co-occur.

`contrasts_with`:

- Require confusion evidence.
- Prefer symmetric rendering in UI, but store one directed row unless implementation later chooses canonical symmetric pairs.
- Weight should reflect repeated confusion, not semantic similarity alone.

`applied_in`:

- Require from/to role compatibility: concept/method → application/assessment.
- Good for `断句 → 翻译`, `实词 → 翻译`, `句式 → 阅读理解`.

`derived_from`:

- Use only when tree cannot express the relation cleanly.
- Reject if from/to are already direct tree ancestor/descendant and no new semantics are added.

`related_to`:

- Use as a conservative weak edge only when it helps navigation or review grouping.
- Penalize overuse; many `related_to` proposals with low accept rate should trigger prompt/rubric tightening.

### 4.4 Reasoning format

Agent reasoning must be concrete:

```text
最近 30 天 e_123 和 e_456 都引用了「之-主谓间」和「之-宾语前置」，judge cause 均为 concept，analysis 都指出用户把结构标志误判为代词，因此提议 contrasts_with。
```

Bad:

```text
这两个知识点都和“之”有关，容易混淆。
```

### 4.5 Proposal payload additions

Current `ProposeKnowledgeEdge` payload has `from_knowledge_id`, `to_knowledge_id`, `relation_type`, `weight`, `reasoning`.

Recommended next addition:

```ts
{
  evidence_event_ids: string[];
  evidence_level: 'strong' | 'medium';
  subject_id: string;
}
```

Do not add this until the event schema and accept UI are updated together.

---

## 5. Tool Output Fixtures

Before implementing graph reader tools, create fixed fixtures that force useful context:

| fixture | question | expected tool behavior |
|---|---|---|
| `wenyan-zhi-confusion` | 我为什么老错“之”？ | `query_knowledge` returns `之` children, recent failures, and `contrasts_with` candidates |
| `wenyan-translation-prereq` | 翻译总错，是不是实词问题？ | `expand_knowledge_subgraph` shows `实词/句式/虚词 → 翻译` candidate paths |
| `wenyan-zero-result` | 最近有没有“焉”的错题？ | read tool returns 0 result with corrective query suggestions |
| `edge-duplicate` | propose existing edge | proposal writer rejects duplicate live/pending edge |

These fixtures test whether the agent can understand context, not just whether SQL returns rows.

---

## 6. Implementation Notes

Recommended order:

1. Add `SubjectGraphGuide` schema and storage path (`subject_graph_guide` table or `artifact(type='subject_graph_guide')`).
2. Add guide seed/enrich service: `seedSubjectGraphGuide()` and `enrichSubjectGraphGuide()`.
3. Add `src/server/ai/tools/read/get_subject_graph_overview.ts`.
4. Add `query_knowledge` and fixtures.
5. Add `expand_knowledge_subgraph`.
6. Tighten `propose_knowledge_edge` to require `evidence_event_ids` for agent proposals.
7. Add `ToolUseCard` summaries based on each tool's `summarize()`.

Keep `KnowledgeReviewTask`'s current single `write_proposal` MCP tool until read tools exist. The next iteration should split read and proposal tools instead of sending a full tree snapshot into the prompt.
