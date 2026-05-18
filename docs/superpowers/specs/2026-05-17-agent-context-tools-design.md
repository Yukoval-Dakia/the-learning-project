# Agent Context Tools Design

**Status**: design spec for the next agent-tool iteration.
**Scope**: internal runtime tools for Learning Orchestrator / Copilot / Dreaming / Maintenance.
**Non-scope**: public plugin platform, standalone external MCP server, direct destructive graph mutation.

## Goal

Give agents enough structured context to make grounded decisions, then make it cheap and safe for them to produce proposals.

The tool layer should help an agent answer three questions:

1. What is the current learning state?
2. What does the relevant subject graph mean?
3. What proposal can I make, with evidence, without mutating hard facts directly?

This follows the existing Orchestrator boundary: read state, choose strategy, dispatch registered tasks, and write proposal/evidence. It must not become a generic plugin system or a database editor.

## Design Principles

1. **Domain tools first, MCP second**.
   The core abstraction is a project-owned `DomainTool` such as `query_knowledge` or `propose_knowledge_edge`. MCP is only the current transport adapter for Claude Agent SDK tool calls.

2. **Context readers return semantics, not rows**.
   A graph read tool must return paths, relation meanings, evidence snippets, and subject reading hints. Raw `knowledge` / `knowledge_edge` rows are not enough for an agent to understand why a node matters.

3. **Proposal writers are dry-run by default**.
   Agent-created graph changes write `event(action='propose')`. User accept routes perform the real mutation inside normal server transactions.

4. **Guides are context, not mutations**.
   Subject Graph Guides can be auto-seeded and enriched because they only explain how to read an area. They do not create nodes or edges. Any graph mutation derived from a guide still goes through proposal.

5. **Tool permissions are task-scoped**.
   Each task keeps an allowlist. The runner injects only the tools declared for that task.

6. **Every call is observable, but not every call is user-visible**.
   `tool_call_log` records raw calls. `event(action='experimental:tool_use')` mirrors calls that are user-facing, causal for a proposal, or needed in `/events/[id]` traces.

7. **Summaries are part of the tool contract**.
   Each tool owns a compact folded summary so Copilot / inbox / event traces do not show generic JSON truncation.

8. **Records feed memory; they are not memory**.
   `LearningRecord` is raw, traceable, activity-grounded learning context. The first
   memory layer is a Dreaming-maintained brief note with three prose sections:
   recent week, recent months, and long-term memory. Users should not manually maintain
   durable learner state; agents should refresh it from evidence.

## Internal Tool Abstraction

Proposed files:

```text
src/server/ai/tools/
  types.ts
  registry.ts
  mcp.ts
  read/
    query_events.ts
    query_records.ts
    get_record_context.ts
    query_knowledge.ts
    get_question_context.ts
    query_mistakes.ts
    get_attempt_context.ts
    get_review_due.ts
    get_learning_item_context.ts
    query_memory_brief.ts
  propose/
    propose_knowledge_edge.ts
    propose_knowledge_mutation.ts
    propose_variant.ts
    attribute_mistake.ts
    propose_learning_item_completion.ts
    propose_learning_item_relearn.ts
    propose_record_links.ts
    propose_record_promotion.ts
```

Proposed shape:

```ts
type ToolEffect = 'read' | 'propose' | 'write';

type ToolMirrorPolicy = 'never' | 'when_user_visible' | 'when_causal' | 'always';

interface DomainTool<Input, Output> {
  name: string;
  description: string;
  effect: ToolEffect;
  inputSchema: z.ZodType<Input>;
  outputSchema: z.ZodType<Output>;
  execute(ctx: ToolContext, input: Input): Promise<Output>;
  summarize(input: Input, output: Output): string;
  mirrorEvent: ToolMirrorPolicy;
}
```

`registry.ts` is the source of truth for domain tools. `mcp.ts` wraps a selected allowlist into an in-process MCP server for Claude Agent SDK:

```ts
const selected = resolveAllowedDomainTools(taskKind);
const mcpServers = createInProcessToolMcpServer(selected, ctx);

runAgentTask(taskKind, input, {
  ...ctx,
  allowedTools: selected.map((t) => t.mcpName),
  mcpServers,
});
```

This does not create a public MCP server. A public MCP endpoint can be added later by reusing the same `DomainTool` registry.

## Knowledge Graph Reader Tools

The knowledge graph is the first place where agents need better context. The tool suite should present graph semantics at three levels.

### 1. `get_subject_graph_overview`

Purpose: give the agent the subject map and graph legend before local reasoning.

Input:

```ts
{
  subject_id: string;
  includeWeaknessSummary?: boolean;
}
```

Output:

```ts
{
  subject_id: string;
  graph_version: number;
  root_nodes: Array<{ id: string; name: string }>;
  relation_types: Array<{
    type: 'prerequisite' | 'related_to' | 'contrasts_with' | 'applied_in' | 'derived_from' | `experimental:${string}`;
    direction: 'directed' | 'symmetric';
    meaning: string;
  }>;
  clusters: Array<{
    name: string;
    root_id: string;
    child_count: number;
    edge_count: number;
    weak_node_count?: number;
    recent_failure_count_30d?: number;
  }>;
  reading_hint: string;
}
```

Important behavior:

- The reading hint must explain that `parent_id` is the backbone tree and `knowledge_edge` is the typed mesh.
- Subject-specific conventions belong here. For an existing `wenyan` graph, the overview might identify clusters such as virtual words, sentence patterns, content words, translation methods, and reading comprehension. A new solid-geometry subject would instead seed clusters like spatial relations, polyhedra, sections, surface/volume, and proof methods.
- This tool should be cheap enough for Copilot to call at session start, but not mandatory for every Backend Purpose Agent.

### 2. `query_knowledge`

Purpose: find nodes by text or id, then return graph-aware summaries.

Input:

```ts
{
  subject_id: string;
  query?: string;
  node_id?: string;
  include?: Array<'ancestors' | 'children' | 'neighbors' | 'stats' | 'recent_failures'>;
  relation_types?: string[];
  limit?: number;
}
```

Output:

```ts
{
  nodes: Array<{
    id: string;
    name: string;
    parent_id: string | null;
    path: string[];
    children_count: number;
    edge_count: number;
    stats?: {
      recent_failure_count_30d: number;
      last_touched_at: string | null;
      mastery_estimate: number | null;
    };
  }>;
  edges: Array<{
    id: string;
    from_knowledge_id: string;
    to_knowledge_id: string;
    relation_type: string;
    weight: number;
    evidence_event_ids: string[];
  }>;
  recent_failures?: Array<{
    event_id: string;
    question_id: string;
    cause: string | null;
    created_at: string;
    excerpt: string;
  }>;
}
```

This is the default Copilot tool for questions like "我为什么老错之". It should return enough local context to answer without preloading the whole graph.

### 3. `expand_knowledge_subgraph`

Purpose: read a bounded local subgraph around a center node.

Input:

```ts
{
  center_node_id: string;
  depth: 1 | 2 | 3;
  include: Array<'ancestors' | 'children' | 'neighbors' | 'recent_failures' | 'mastery'>;
  relation_types?: string[];
  max_nodes?: number;
}
```

Output:

```ts
{
  center: { id: string; name: string; path: string[] };
  nodes: Array<{ id: string; name: string; path: string[]; role: 'ancestor' | 'child' | 'neighbor' | 'center' }>;
  edges: Array<{ from: string; to: string; relation_type: string; weight: number }>;
  paths: Array<{
    from: string;
    to: string;
    relation_type: string;
    reason: string;
  }>;
  evidence: {
    recent_failures: Array<{ event_id: string; question_id: string; cause: string | null; excerpt: string }>;
    weak_points: Array<{ knowledge_id: string; signal: string; score: number }>;
  };
}
```

This tool is for graph reasoning and proposal preparation. It should not return more nodes than the agent can inspect.

### 4. `find_knowledge_paths`

Purpose: answer "why are A and B related?" without making the model infer paths from raw node arrays.

Input:

```ts
{
  from_knowledge_id: string;
  to_knowledge_id: string;
  max_depth?: number;
  relation_types?: string[];
}
```

Output:

```ts
{
  paths: Array<{
    node_ids: string[];
    node_names: string[];
    edge_types: string[];
    explanation: string;
  }>;
}
```

This is useful for Copilot explanations and for validating whether a proposed edge is redundant.

## Event, Record, And Mistake Reader Tools

The event stream is the canonical action log. `LearningRecord` is the canonical
activity-grounded user context object. A mistake is both:

- `learning_record(kind='mistake')` for user-facing record UX, and
- `event(action='attempt', subject_kind='question', outcome='failure')` for mastery,
  review, attribution, and event-chain evidence.

Correct answers are also signals. Confirmed solved questions should write
`event(action='attempt', subject_kind='question', outcome='success')` even when they do not
create a `LearningRecord`. Create `learning_record(kind='worked_example')` only when the
correct attempt carries reusable context worth showing in records / agent context.

These tools should let an agent understand learning history without exposing raw SQL or
large JSON payloads.

Record invariant: runtime records are not orphan notes. Each record should reference the
activity that created it through `origin_event_id`; direct `/record` entry creates a
capture event first, then materializes the record.

Boundary with memory:

- `query_records` reads original evidence, not long-term learner beliefs.
- `query_memory_brief` reads the current Dreaming-maintained summary, not raw rows.
- Brief-note refresh must cite `learning_record.id`, `event.id`, `knowledge.id`, or
  `artifact.id` evidence. Do not let an agent write unsupported profile claims.
- Do not implement vector memory or per-fact profile objects in the first
  `LearningRecord` migration; keep this tool layer evidence-rich enough that structured
  memory can be derived later.

### `query_events`

Purpose: bounded event-log read for timeline and causal-chain questions.

Input:

```ts
{
  actor_kind?: 'user' | 'agent' | 'cron' | 'system';
  actor_ref?: string;
  action?: string[];
  subject_kind?: string[];
  subject_id?: string;
  outcome?: Array<'success' | 'failure' | 'partial'>;
  caused_by_event_id?: string;
  time_range?: { from?: string; to?: string };
  include_chain?: 'none' | 'parents' | 'children' | 'both';
  payload_detail?: 'summary' | 'typed';
  limit?: number;
}
```

Output:

```ts
{
  events: Array<{
    id: string;
    actor: { kind: string; ref: string };
    action: string;
    subject: { kind: string; id: string };
    outcome: string | null;
    created_at: string;
    caused_by_event_id: string | null;
    payload_summary: string;
    typed_payload?: unknown;
    child_counts?: Record<string, number>;
  }>;
  truncated: boolean;
}
```

Important behavior:

- Default `limit=20`, hard max `50` for agent calls. Admin UI routes can keep a higher
  limit outside this tool contract.
- `payload_detail='summary'` is the default. It should keep prompts, answers, and
  generated text as excerpts, not full markdown blobs.
- `payload_detail='typed'` still goes through `parseEvent` and returns only known
  event shapes. It must not become raw JSONB passthrough.
- `include_chain` returns only one-hop parent / children unless a later tool explicitly
  adds deeper graph traversal.

Folded summary:

```text
events · attempt/failure + judge · 12 rows · last 7d
```

### `query_records`

Purpose: read activity-grounded learning records across mistakes, examples, questions,
insights, reflections, observations, and resource notes.

Input:

```ts
{
  kind?: Array<
    | 'mistake'
    | 'worked_example'
    | 'open_question'
    | 'insight'
    | 'reflection'
    | 'observation'
    | 'resource_note'
  >;
  knowledge_ids?: string[];
  subject_id?: string;
  question_id?: string;
  activity_kind?: string[];
  origin_event_id?: string;
  attempt_event_id?: string;
  learning_item_id?: string;
  processing_status?: Array<'raw' | 'linked' | 'actioned' | 'archived'>;
  query?: string;
  time_range?: { from?: string; to?: string };
  include?: Array<'links' | 'question' | 'attempt' | 'artifact' | 'learning_item' | 'knowledge_path'>;
  limit?: number;
}
```

Output:

```ts
{
  rows: Array<{
    record_id: string;
    kind: string;
    title: string | null;
    excerpt: string;
    source: string;
    capture_mode: string;
    activity_kind: string;
    origin_event_id: string | null;
    processing_status: string;
    knowledge_ids: string[];
    links: {
      question_id: string | null;
      attempt_event_id: string | null;
      artifact_id: string | null;
      learning_item_id: string | null;
      source_document_id: string | null;
    };
    created_at: string;
  }>;
}
```

Important behavior:

- This is the default Copilot / Coach reader for user activity context that has been
  materialized into records.
- Returned records are evidence for reasoning and future memory extraction, not final memory
  statements.
- `kind='mistake'` records can include attempt and attribution summaries, but deep mistake
  explanation should use `get_attempt_context` or `get_record_context`.
- `open_question`, `reflection`, and `insight` are first-class signals for proposals; they
  should not be hidden behind a separate StudyLog concept.

Folded summary:

```text
records · mistake/open_question/reflection · 9 rows · last 30d
```

### `query_mistakes`

Purpose: return the specialized mistake view, with the current best attribution and review
state. This is a shortcut over `query_records(kind='mistake')` plus attempt/review joins.

Input:

```ts
{
  knowledge_ids?: string[];
  causes?: Array<
    | 'concept'
    | 'knowledge_gap'
    | 'calculation'
    | 'reading'
    | 'memory'
    | 'expression'
    | 'method'
    | 'carelessness'
    | 'time_pressure'
    | 'other'
  >;
  needs_attribution?: boolean;
  review_due?: boolean;
  has_variant?: boolean;
  time_range?: { from?: string; to?: string };
  include?: Array<'question' | 'judge' | 'review_state' | 'variants' | 'knowledge_path'>;
  limit?: number;
}
```

Output:

```ts
{
  rows: Array<{
    record_id: string;
    attempt_event_id: string;
    question_id: string;
    prompt_excerpt?: string;
    answer_excerpt: string | null;
    referenced_knowledge_ids: string[];
    knowledge_paths?: string[][];
    cause: {
      source: 'user' | 'judge' | 'none';
      primary_category?: string;
      secondary_categories?: string[];
      confidence?: number;
      analysis_excerpt?: string;
      event_id?: string;
    };
    review_state?: {
      due_at: string | null;
      last_rating: 'again' | 'hard' | 'good' | null;
      overdue: boolean;
    };
    variants?: Array<{ question_id: string; draft_status: string; created_at: string }>;
    created_at: string;
  }>;
}
```

Important behavior:

- `record_id` is the UI record id; `attempt_event_id` is the event/facts id.
- `attempt_event_id` is the stable "mistake id" in the event-stream model.
- User attribution wins over agent attribution when both exist.
- `review_due=true` joins the deterministic FSRS projection; the tool must not recompute
  or mutate scheduling state.
- Variants are shown as draft questions derived from the attempt, not as nested mistakes.

Folded summary:

```text
mistakes · concept/knowledge_gap · 8 rows · 3 due
```

### `get_record_context`

Purpose: explain one LearningRecord end-to-end, regardless of kind.

Input:

```ts
{
  record_id: string;
  include?: Array<'question' | 'attempt' | 'attribution' | 'review_history' | 'artifact' | 'learning_item' | 'knowledge_context' | 'event_chain'>;
}
```

Output:

```ts
{
  record: {
    id: string;
    kind: string;
    title: string | null;
    content_md: string;
    source: string;
    capture_mode: string;
    activity_kind: string;
    origin_event_id: string | null;
    processing_status: string;
    knowledge_ids: string[];
    created_at: string;
  };
  question?: {
    id: string;
    prompt_md: string;
    reference_md: string | null;
    knowledge_ids: string[];
  };
  attempt?: {
    attempt_event_id: string;
    answer_md: string | null;
    answer_image_refs: string[];
    outcome: 'failure' | 'success' | 'partial';
  };
  attribution?: {
    user_cause?: unknown;
    judge?: unknown;
    chosen_source: 'user' | 'judge' | 'none';
  };
  artifact?: { id: string; type: string; summary: string };
  learning_item?: { id: string; title: string; status: string };
  knowledge_context?: {
    paths: string[][];
    related_edges: Array<{ from: string; to: string; relation_type: string; reason: string }>;
  };
  event_chain?: { parent: string | null; children: Array<{ id: string; action: string }> };
}
```

This is the main tool for "这条记录后续能做什么？". For mistakes, it should return the
linked attempt context. For open questions and reflections, it should return enough linked
knowledge and recent activity for proposal generation.

For memory extraction jobs, this tool should be the preferred evidence reader: the job can
ask "is this a durable pattern or only a one-off record?" only after resolving links,
attempt chains, and nearby graph context.

### `get_question_context`

Purpose: explain one stored question as a learning material, independent of whether the
question came from a mistake, a correct homework answer, a quiz, an embedded check, or a
variant.

Input:

```ts
{
  question_id: string;
  include?: Array<
    | 'source'
    | 'attempts'
    | 'review_history'
    | 'fsrs_state'
    | 'records'
    | 'variants'
    | 'knowledge_context'
    | 'assets'
  >;
  attempt_limit?: number;
  review_limit?: number;
}
```

Output:

```ts
{
  question: {
    id: string;
    prompt_md: string;
    reference_md: string | null;
    kind: string;
    knowledge_ids: string[];
    difficulty: number;
    source: string;
    source_ref: string | null;
    recorded_at: string; // question.created_at
  };
  lifecycle: {
    first_attempted_at: string | null;
    last_attempted_at: string | null;
    attempt_counts: { success: number; partial: number; failure: number };
    first_reviewed_at: string | null;
    last_reviewed_at: string | null;
    review_count: number;
    due_at: string | null;
    last_review_event_id: string | null;
    linked_record_ids: string[];
  };
  attempts?: Array<{
    event_id: string;
    outcome: 'success' | 'partial' | 'failure';
    answer_excerpt: string;
    created_at: string;
  }>;
  review_history?: Array<{ event_id: string; fsrs_rating: string; created_at: string }>;
  records?: Array<{ record_id: string; kind: string; excerpt: string; created_at: string }>;
  variants?: Array<{ question_id: string; draft_status: string; created_at: string }>;
  knowledge_context?: Array<{ knowledge_id: string; path: string[]; mastery: number | null }>;
  source_assets?: Array<{ asset_id: string; role: string; crop_ref?: string }>;
}
```

Important behavior:

- `recorded_at` comes from `question.created_at`.
- Attempts and reviews are derived from `event`, not duplicated mutable counters on
  `question`.
- Current scheduling is read from `material_fsrs_state`.
- Default `attempt_limit=10` and `review_limit=10`; counts should still cover the full
  question history.
- This is the preferred tool for "这道题是什么时候进来的 / 做过几次 / 复习过几次 / 下次何时复习".

### `get_attempt_context`

Purpose: explain one mistake end-to-end.

Input:

```ts
{
  attempt_event_id: string;
  include?: Array<'question' | 'answer' | 'judge' | 'review_history' | 'variants' | 'knowledge_context' | 'event_chain'>;
}
```

Output:

```ts
{
  attempt_event_id: string;
  question: {
    id: string;
    prompt_md: string;
    reference_md: string | null;
    knowledge_ids: string[];
    recorded_at: string;
    source: string;
    source_ref: string | null;
  };
  answer: { answer_md: string | null; answer_image_refs: string[] };
  attribution: {
    user_cause?: unknown;
    judge?: unknown;
    chosen_source: 'user' | 'judge' | 'none';
  };
  knowledge_context?: {
    paths: string[][];
    related_edges: Array<{ from: string; to: string; relation_type: string; reason: string }>;
  };
  review_history?: Array<{ event_id: string; fsrs_rating: string; created_at: string }>;
  variants?: Array<{ question_id: string; prompt_excerpt: string; draft_status: string }>;
  event_chain?: { parent: string | null; children: Array<{ id: string; action: string }> };
}
```

This is the main Copilot tool for questions like "这题我到底错在哪里？". It should be
preferred over making the agent call `query_events`, `query_knowledge`, and review APIs
separately for the same attempt.

## Review And Learning Reader Tools

These tools expose deterministic learning state. They are read-only because review submit,
LearningItem transitions, and LearningRecord creation already have route-level owners.

### `get_review_due`

Purpose: read the FSRS due queue and explain why each card is due.

Input:

```ts
{
  limit?: number;
  knowledge_ids?: string[];
  causes?: string[];
  include_reason?: boolean;
}
```

Output:

```ts
{
  rows: Array<{
    question_id: string;
    prompt_excerpt: string;
    knowledge_ids: string[];
    fsrs_state: unknown | null;
    due_at: string | null;
    reason: 'never_reviewed_failure' | 'overdue' | 'filtered_match';
    latest_mistake?: { attempt_event_id: string; cause: string | null; created_at: string };
  }>;
  queue_summary: {
    total_returned: number;
    never_reviewed_count: number;
    overdue_count: number;
    top_knowledge_ids: string[];
  };
}
```

Important behavior:

- This wraps the existing `/api/review/due` semantics: due cards from
  `material_fsrs_state`, plus never-reviewed failure attempts.
- It never calls `POST /api/review/submit` and never updates FSRS.
- Review Orchestrator should prefer precomputed queue summaries. Letting an LLM call this
  tool is useful for Copilot explanations or oversized queues, not for the normal review
  route.

### `get_learning_item_context`

Purpose: give the agent enough context to teach, propose completion, or propose relearning
for one LearningItem.

Input:

```ts
{
  learning_item_id: string;
  include?: Array<'parent' | 'children' | 'primary_artifact' | 'completion_evidence' | 'recent_events' | 'records' | 'knowledge_context'>;
}
```

Output:

```ts
{
  item: {
    id: string;
    title: string;
    content: string;
    status: 'pending' | 'in_progress' | 'done' | 'dismissed' | 'resting' | 'archived';
    knowledge_ids: string[];
    primary_artifact_id: string | null;
    parent_learning_item_id: string | null;
  };
  hierarchy?: {
    parent?: { id: string; title: string; status: string };
    children: Array<{ id: string; title: string; status: string; knowledge_ids: string[] }>;
  };
  primary_artifact?: {
    id: string;
    type: string;
    generation_status: string;
    section_summaries: string[];
  };
  evidence?: Array<{ id: string; path: string; summary: string; created_at: string }>;
  recent_activity?: Array<{ kind: 'event' | 'learning_record'; id: string; summary: string; created_at: string }>;
  knowledge_context?: Array<{ knowledge_id: string; path: string[]; mastery: number | null }>;
}
```

Important behavior:

- Hub versus atomic is derived from children; do not add a new `kind` enum just for the
  tool.
- Artifact sections should be summarized unless the task explicitly needs the full note.
- Status transitions still go through existing LearningItem routes or user-accepted
  proposals. This tool only reads.

### `query_memory_brief`

Purpose: give an agent the current learner-memory digest before it proposes strategy,
teaching, or long-horizon maintenance. This is a read tool over the derived
`memory_brief_note` table. It does not inspect raw records itself.

Input:

```ts
{
  scope_key?: 'global' | `subject:${string}`;
  include_evidence?: boolean;
}
```

Output:

```ts
{
  note: {
    id: string;
    scope_key: string;
    subject_id: string | null;
    recent_week_md: string;
    recent_months_md: string;
    long_term_md: string;
    refreshed_at: string | null;
    source_event_id: string | null;
    version: number;
  } | null;
  evidence?: {
    recent_week_ids: string[];
    recent_months_ids: string[];
    long_term_ids: string[];
  };
}
```

Important behavior:

- Return `note=null` when Dreaming has not produced a brief yet; callers should continue
  with `query_records` / `query_events` instead of hallucinating learner profile.
- Keep sections short enough to prepend to an agent prompt. The table stores prose, not
  arbitrary JSON profile facts.
- Evidence ids are ids only by default. The caller can resolve details through
  `query_records`, `query_events`, `get_record_context`, or `query_knowledge`.

Folded summary:

```text
memory brief · global · refreshed 2026-05-18 · week/months/long-term
```

### Deprecated: `query_study_log`

Do not implement this tool. The StudyLog model is retired by the one-time
`LearningRecord` migration. Use `query_records` with `kind` filters instead.

## Knowledge Graph Proposal Tools

### `propose_knowledge_edge`

Purpose: propose one typed mesh edge.

Input:

```ts
{
  from_knowledge_id: string;
  to_knowledge_id: string;
  relation_type: 'prerequisite' | 'related_to' | 'contrasts_with' | 'applied_in' | 'derived_from' | `experimental:${string}`;
  weight?: number;
  reasoning: string;
  evidence_event_ids: string[];
}
```

Behavior:

- Validate both nodes exist and are in the same subject unless cross-subject edges are explicitly enabled later.
- Reject `from_knowledge_id === to_knowledge_id`.
- Reject exact duplicate live edge.
- Reject a mesh edge that merely repeats the tree `parent_id` relationship unless the relation adds new semantics.
- Write `event(action='propose', subject_kind='knowledge_edge', actor_kind='agent')`.
- Do not insert `knowledge_edge`.

Folded summary:

```text
propose_edge · 之-主谓间 → 之-宾语前置 · contrasts_with · 3 evidence
```

### `propose_knowledge_mutation`

Purpose: propose tree maintenance actions.

Input:

```ts
{
  mutation: 'propose_new' | 'reparent' | 'merge' | 'split' | 'archive';
  payload: Record<string, unknown>;
  reasoning: string;
  evidence_event_ids: string[];
}
```

Behavior:

- All destructive or structural tree changes remain proposal-only.
- The accept route owns the real mutation and rollback window.
- This tool should be allowed for Maintenance / KnowledgeReview tasks, not for every Copilot turn by default.

## Non-Graph Proposal And Action Tools

Not every useful tool is a graph mutation. Some tools append domain events or create draft
questions. These are still bounded by existing write owners and idempotency rules.

### `attribute_mistake`

Purpose: run the existing attribution path for one failure attempt and append a `judge`
event if needed.

Input:

```ts
{
  attempt_event_id: string;
}
```

Output:

```ts
{
  status: 'written' | 'skipped:existing_judge' | 'skipped:not_failure_attempt' | 'failed';
  judge_event_id?: string;
  cause?: {
    primary_category: string;
    secondary_categories: string[];
    confidence: number;
    analysis_excerpt: string;
  };
}
```

Behavior:

- The tool does not accept `cause` from the calling agent. It invokes `AttributionTask` and
  writes the parsed result through the existing `writeEvent` path.
- If a judge event already exists, skip by default. User-authored cause remains the
  preferred attribution in reader tools.
- This is an append-only write, not a proposal, because attribution is already modeled as
  evidence on an attempt event. It must be visible in traces when triggered by Copilot.

### `propose_variant`

Purpose: generate one targeted draft variant question for a failure attempt.

Input:

```ts
{
  attempt_event_id: string;
  count?: 1;
}
```

Output:

```ts
{
  status:
    | 'generated'
    | 'skipped:no_judge_yet'
    | 'skipped:cause_not_targetable'
    | 'skipped:max_depth'
    | 'skipped:already_has_variant'
    | 'failed';
  variant_question_ids: string[];
  reasoning_summary?: string;
}
```

Behavior:

- Reuse the existing `VariantGenTask` / `runVariantGen` rules.
- MVP count is capped at 1. More variants require an explicit future cap and UI affordance.
- Do not generate variants for `carelessness`, `time_pressure`, or `other`.
- Do not let variants spawn more variants. Respect `source='mistake_variant'` and
  `variant_depth` termination.
- The write is a draft `question` with `source='mistake_variant'`; if a future UI needs
  accept/dismiss, wrap that route around the draft status instead of letting the LLM insert
  final questions.

### `propose_learning_item_completion`

Purpose: propose that a LearningItem is ready to move to `done`.

Input:

```ts
{
  learning_item_id: string;
  triggering_signals: Array<'mastery_high_persisted' | 'check_all_passed' | 'no_recent_mistake' | 'user_stated_understanding'>;
  evidence_event_ids: string[];
  reasoning: string;
}
```

Behavior:

- Write a proposal event, not a direct `learning_item.status='done'` update.
- Accept route creates `completion_evidence(path='ai_propose')` and performs the status
  transition using the normal optimistic-lock path.
- Dismiss creates a cooldown signal so the same item is not proposed again immediately.

### `propose_learning_item_relearn`

Purpose: propose that a resting/done item should return to active learning.

Input:

```ts
{
  learning_item_id: string;
  current_mastery: number | null;
  peak_mastery?: number | null;
  days_since_done?: number;
  evidence_event_ids: string[];
  reasoning: string;
}
```

Behavior:

- Write a proposal event only. The accept route transitions `resting | done -> pending` or
  `in_progress` according to the LearningItem state machine.
- This tool belongs to Dreaming / Coach / Maintenance, not normal review submission.

### `propose_record_links`

Purpose: propose better links from a LearningRecord to knowledge nodes, a LearningItem,
an artifact, or a question.

Input:

```ts
{
  record_id: string;
  proposed_links: Array<{
    target_kind: 'knowledge' | 'question' | 'learning_item' | 'artifact';
    target_id: string;
    relation: 'about' | 'evidence_for' | 'follow_up' | 'source_for';
    confidence: number;
    reasoning: string;
  }>;
  evidence_event_ids?: string[];
}
```

Behavior:

- Write proposal only. Accept route updates `learning_record` links.
- This is especially useful for `open_question`, `insight`, `reflection`, and
  `resource_note`, where the user may not know which graph node to attach.

### `propose_record_promotion`

Purpose: propose turning a record into a stronger learning object.

Input:

```ts
{
  record_id: string;
  target: 'question' | 'learning_item' | 'artifact';
  reasoning: string;
  draft?: unknown;
}
```

Behavior:

- `open_question -> learning_item`: propose a concrete item to study.
- `worked_example -> question`: create a reviewable question draft.
- `resource_note -> artifact`: create a note/source artifact.
- The real create/update happens only after user accept.

## What Should Not Be A Tool

- `refresh_memory_brief_note`. Dreaming owns this as a scheduled boss handler, because
  refreshing learner memory is a maintenance side effect with evidence validation and an
  audit event, not an arbitrary capability for every agent turn.
- Direct `db.insert` / `db.update` / raw SQL exposed to an LLM.
- Accept / dismiss / rollback handlers. These are user actions and deterministic routes,
  not tools an agent calls by itself.
- `POST /api/review/submit`. Review scheduling is a user answer + FSRS transaction, not
  agent automation.
- Unbounded search across events, notes, or graph nodes.
- File system, network, or external MCP tools inside the learning runtime unless a future
  requirement explicitly introduces them.

## Task Allowlist Defaults

| Task / surface | Read tools | Proposal / action tools | Notes |
|---|---|---|---|
| `KnowledgeReviewTask` | `get_subject_graph_overview`, `expand_knowledge_subgraph`, `query_knowledge`, `find_knowledge_paths`, `query_events` | `propose_knowledge_edge`, `propose_knowledge_mutation` | Maintenance-grade graph work |
| Copilot | `query_memory_brief`, `get_subject_graph_overview`, `query_knowledge`, `query_events`, `query_records`, `get_record_context`, `get_question_context`, `query_mistakes`, `get_attempt_context`, `get_review_due` | `propose_knowledge_edge`; `attribute_mistake` / `propose_variant` only via user suggestion | User-visible traces required |
| Dreaming / Maintenance | Same as `KnowledgeReviewTask`, plus `query_records`, `get_question_context`, `query_mistakes`, `get_learning_item_context`, `query_memory_brief`, weak-point readers | `propose_knowledge_edge`, `propose_knowledge_mutation`, `propose_learning_item_completion`, `propose_learning_item_relearn`, `propose_record_links`, `propose_record_promotion` | Batch cost controls apply |
| Review Orchestrator | Usually no tool call; deterministic queue summary first. Optional `get_review_due` for explanation. | none | Add read tools only if the queue becomes too large for precomputed summaries |
| Learning Intent Orchestrator | `query_knowledge`, `get_subject_graph_overview`, `get_learning_item_context` after creation | none for MVP | Case 3c fence remains: no auto-create graph beyond the accepted learning intent path |
| TeachingTurnTask | `query_memory_brief`, `get_learning_item_context`, `query_records`, optional `query_knowledge` | none | Read enough context to teach; no hidden state mutation |

## Tool Logging And Event Mirror

Every tool call writes `tool_call_log` with:

- task run id
- tool name
- parsed input
- normalized output or error
- latency
- iteration

Mirror `experimental:tool_use` event when one of these is true:

- the call appears in Copilot UI,
- the call caused a proposal event,
- the call is part of a Dreaming / Maintenance trace shown in `/inbox` or `/events/[id]`,
- the call failed and led to a corrective chip.

Do not mirror every backend read into the event table. High-volume internal reads belong in `tool_call_log`.

## Engineering Sequence

1. **LearningRecord migration first**.
   Complete the one-time migration in [`docs/modules/records.md`](../../modules/records.md):
   add `learning_record`, remove `study_log`, and move `/record` creation to `/api/records`.
   Do not implement `query_records` against the retired StudyLog model.

2. **Doc alignment**.
   Update architecture and AI README to state that current runtime uses Claude Agent SDK with in-process MCP adapters. Keep the old Vercel AI SDK references only as historical ADR context.

3. **Read-only registry**.
   Add `DomainTool` types, registry, and tests. Implement `query_events`, `query_records`, `query_mistakes`,
   `get_subject_graph_overview`, `query_knowledge`, and `expand_knowledge_subgraph` without
   connecting them to LLMs yet.

4. **In-process MCP bridge**.
   Wrap selected `DomainTool`s in an in-process MCP server and pass it through `runAgentTask` / `streamTask`. Keep `allowedTools` in `src/ai/registry.ts` as the task-level policy surface.

5. **Context-specific readers**.
   Add `get_question_context`, `get_attempt_context`, `get_review_due`, `get_learning_item_context`, and
   `get_record_context` after the generic readers are stable. These tools are mostly
   composition over existing route/service read paths.

6. **Proposal and action tools**.
   Implement `propose_knowledge_edge` and `propose_knowledge_mutation` as event writers.
   Reuse existing edge accept handlers for actual mutation. Then expose
   `attribute_mistake`, `propose_variant`, `propose_record_links`, and
   `propose_record_promotion` as wrappers around existing owner services or proposal events,
   not as direct DB writes.

7. **Copilot trace UI**.
   Use each tool's `summarize()` method for `ToolUseCard` folded summaries. Keep args/result expanded view available for debugging.

8. **Remote MCP only if needed**.
   If external clients need access later, expose the same registry as a standalone MCP server. Do not fork tool definitions.

## Brainstorm Backlog

These are adjacent docs/design topics that should be brainstormed before implementation:

1. **Subject Graph Guide Contract**.
   **Promoted to [`docs/modules/knowledge.md`](../../modules/knowledge.md)**. The guide is auto-seeded when a subject or large learning area appears, then enriched over time. It defines cluster names, relation hints, and proposal guardrails without requiring user confirmation.

2. **Context Budget Policy**.
   Decide per surface how much context is allowed: overview size, max subgraph nodes, max recent failures, and when to require follow-up tool calls instead of larger payloads.

3. **Proposal Quality Rubric**.
   **Promoted to [`docs/modules/knowledge.md`](../../modules/knowledge.md)**. It defines evidence levels, relation-specific gates, and duplicate/redundant edge checks.

4. **Tool Eval Fixtures**.
   Seed fixture list now lives in [`docs/modules/knowledge.md`](../../modules/knowledge.md). Implementation still needs actual test fixtures.

5. **ToolUse Event Promotion**.
   ADR-0011 keeps `experimental:tool_use`. After three real tools ship, revisit whether to promote to stable `tool_use`.

6. **Copilot Suggestion Semantics**.
   Clarify which suggestions are `proactive` versus `corrective`, and how accepting them affects metrics.

7. **Read Tool Security Model**.
   Single-user auth is simple, but tools still need resource boundaries: subject scoping, max result limits, and no filesystem/network reads unless explicitly introduced.

## Open Questions

1. Should Copilot get `propose_knowledge_mutation`, or only `propose_knowledge_edge` at first?
   Recommendation: only edge proposals first; tree mutations are easier to abuse and should stay in Maintenance.

2. Should `query_knowledge` include mastery estimates before ADR-0012 derived view is fully exercised?
   Recommendation: include nullable `mastery_estimate`, but do not let proposals depend on it until the projection is stable.

3. Should every proposal tool require `evidence_event_ids`?
   Recommendation: yes for graph proposals; allow empty only for user-authored manual proposals, not agent proposals.
