# Agent Framework Design - global Copilot, skills, and background agents

> **Status**: design record, 2026-06-04.
> **Context**: follow-up to the 2026-06-03 product architecture discussion.
> Existing ADR-0004 splits "Backend Purpose Agent" and "User Copilot", but that
> document predates the current product decision: Copilot should become the
> single user-facing full agent, while Coach / Dreaming / Maintenance become
> specialized background agents with clear purposes.
>
> **U0 adjudication (2026-06-04 / YUK-205 / ADR-0029)**: the 2026-06-04 U0 grill
> session locked the decision cluster captured in
> [ADR-0029](../../adr/0029-review-engine-lands-on-existing-primitives.md)
> (review engine lands on existing primitives), informed by
> [docs/audit/2026-06-04-design-feasibility-audit.md](../../audit/2026-06-04-design-feasibility-audit.md).
> This spec is amended inline to absorb the relevant rulings (D5/D7/D8/D10) and is
> from now on the **home of agent-tool governance** — memory-access policy and the
> AI-output blast-radius admission rule live in §3; sibling specs (coach-led review
> engine "CO", editable-profile-studio "PS") reference §3 rather than restating it.
> Where a passage below was overturned, it has been rewritten to its adjudicated
> form and flagged with an `Amended 2026-06-04` note rather than deleted.

## 0. Why This Exists

The repo already has an agent substrate:

- Claude Agent SDK runner with MCP tool calls;
- `DomainTool` registry and surface allowlists;
- registered `CopilotTask`, `CoachTask`, `DreamingTask`, and
  `KnowledgeReviewTask`;
- conversation sessions for Active Teaching;
- memory brief / proposal / event infrastructure.

But the product architecture has drifted:

- Copilot is currently still shaped like a `/today` drawer surface.
- Active Teaching is a separate user-facing conversation.
- Coach writes a `TodayPlan`, but review planning is still mostly deterministic
  FSRS/due-list logic.
- Dreaming and Maintenance exist as background proposal producers, but their
  relationship to narrow tasks and task-emitted hints is not explicit.
- Older ADR text still mentions `agent_sessions` even though conversation has
  moved into `learning_session(type='conversation')`.

This document records the new product direction before implementation starts.

## 1. Locked Product Decisions

### 1.1 One User-Facing Conversational Agent

Copilot is the only user-facing conversational agent.

It should:

- live globally across the app;
- automatically receive the user's current context;
- replace the separate "Active Teaching" user-facing chat surface;
- be able to teach, solve, explain, critique, plan, and inspect;
- expose one continuous chat mental model to the user.

The user should not have to choose between "Copilot" and "Teaching". Teaching is
a Copilot skill/state, not a separate product face.

### 1.2 Copilot Has All Capabilities

Copilot should not ask the user to switch capability modes.

In product terms, Copilot always has the full safe capability set. It may adapt
its prompt, context, and behavior through skills, but it should not hide or
remove powers because the user is on a different page.

Safety still applies. The proposal-only invariant itself is owned by
[ADR-0025 ND-5](../../adr/0025-north-star-goal-entity-and-coach-coexistence.md)
(with [ADR-0004](../../adr/0004-pattern-c-two-type-agent-architecture.md)); this
spec references it rather than redefining it, and keeps only the
Copilot-specific increments:

- destructive domain changes are proposal-only unless an existing user-confirmed
  route owns the mutation (ADR-0025 ND-5);
- raw database mutation is not a Copilot capability;
- draft-layer edits may be direct only on surfaces explicitly designed for that
  user-triggered edit.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: the proposal-only invariant
> is canonically owned by ADR-0025 ND-5; the prior free-standing restatement here
> is reduced to a one-line reference so CO §11 / PS §4+§11 / this §1.2 stop
> diverging. Governance detail moved to §3.

### 1.3 Skills Are Behavior Packs, Not Tool Switches

A skill is a prompt/context/policy pack.

Examples:

- review coach skill;
- solve-tutor skill;
- note-reading skill;
- active teaching skill;
- ingestion correction skill.

Skills decide:

- what the agent should pay attention to;
- how it should explain;
- which subject policy to apply;
- what output shape is expected;
- whether to buffer feedback or interrupt.

Skills do not define the tool permission boundary for Copilot. Tool permissions
are governed by the Copilot safety surface. Narrow backend tasks still keep
narrow allowlists.

### 1.4 Current Context Is Automatic

Copilot should automatically know what the user is doing now:

- current route/surface;
- open question, question part, note, artifact, learning item, goal, or review
  paper;
- selected block/text/figure when available;
- active session or attempt;
- current subject;
- recent local events relevant to the surface.

This should be provided by an app context channel and/or a server-side current
context reader, not by asking the user to paste context into chat.

### 1.5 Session Is a Product Concept

Claude Agent SDK session mechanics are transport details. The product session
should be owned by Loom.

Use `learning_session(type='conversation')` plus events/messages as the durable
conversation envelope. Do not revive the old `agent_sessions` / `agent_messages`
ADR shape unless there is a concrete need not covered by `learning_session`.

Long-running Copilot memory should use:

- recent raw turns;
- rolling conversation summary;
- current page context;
- memory brief;
- relevant records/events fetched through tools.

Auto-compression should be the default once a conversation exceeds the short
context window. The user should experience this as one continuous chat.

## 2. Agent Purposes

### 2.1 Copilot

Purpose: user-facing full agent.

Copilot handles:

- direct user questions;
- active teaching;
- solve help;
- note explanation and critique;
- review/paper assistance;
- question/ingestion correction when explicitly triggered;
- proposal explanation and follow-up.

It should be globally mounted and context-aware. It can call all safe DomainTools
and should be able to surface tool calls in the existing tool-card UI.

### 2.2 Coach

Purpose: plan what the learner should do next.

Coach is not the main chat face. It is the planning agent behind:

- daily plan;
- weekly reflection;
- subject/time allocation;
- review paper planning;
- goal strand;
- plan adjustments;
- learning-item lifecycle proposals.

The review-engine design splits review planning into a two-stage pipeline.
Coach produces a strategic **review brief** (subject mix, knowledge focus, time
box, intent tags) and stores it in the existing `TodayPlan.review_session_proposal`
field, grown from its current `{count, estimated_minutes}` shape — Coach does not
mint a new artifact type for this. The tactical paper build (candidate/probe
selection, writing the plan, in-session checkpoint adaptation) is owned by the
narrow `ReviewPlanTask`, whose output is a `tool_quiz` paper artifact. Coach does
not enter the in-session hot loop; `checkpoint_adapt` belongs to `ReviewPlanTask`.

Coach output should be structured artifacts such as `TodayPlan` (carrying the
review brief), not free-form chat history.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: the prior "Coach selects
> knowledge focus / chooses candidates / adapts sections" wording implied Coach
> owns tactical paper building. U0 D5 split this: Coach owns the strategic brief
> only, `ReviewPlanTask` owns tactical selection + adaptation. The pipeline and
> the `ReviewPlanTask` tool surface are defined in the coach-led review-engine
> spec (`2026-06-03-coach-led-review-engine-design.md`, "CO") and
> [ADR-0029](../../adr/0029-review-engine-lands-on-existing-primitives.md); this
> spec cross-references them and does not redefine the pipeline.

### 2.3 Dreaming

Purpose: async synthesis and pattern discovery.

Dreaming runs away from the live interaction loop. It should:

- read recent learning signals;
- read memory brief and records;
- inspect repeated patterns across notes, questions, attempts, proposals, and
  goals;
- create high-value inbox proposals;
- refresh or feed long-term learner memory;
- consume task-emitted notes from narrow tasks.

Dreaming should not own today's operational schedule. That is Coach's job.

### 2.4 Maintenance

Purpose: structural health of the learning substrate.

Maintenance watches for things that make the system harder to reason about:

- broken or duplicate knowledge links;
- stale or conflicting coverage;
- orphaned or malformed question profiles;
- graph shape problems;
- note/artifact consistency problems;
- proposal hygiene.

Maintenance may use broad read tools and structural proposal tools, but it
should not silently mutate durable learning facts.

### 2.5 Narrow Tasks

Purpose: bounded execution.

Examples:

- judge;
- attribution;
- variant generation;
- quiz generation;
- question structure correction;
- note refinement;
- profile/coverage extraction.

Narrow tasks keep narrow tools. They should not become user-facing agents and
should not gain Copilot's full tool surface.

## 3. Tool Permission Model

The DomainTool registry remains the source of truth.

Recommended surfaces:

| Surface | Tool shape |
| --- | --- |
| `copilot` | all safe read/propose tools, plus user-triggered direct-write tools whose routes already enforce scope |
| `coach` | planning reads + plan/lifecycle/knowledge proposal tools |
| `dreaming` | broad reads + proposal/memory-oriented tools |
| `maintenance` | broad reads + structural proposal tools |
| `review_plan_task` | dedicated narrow surface: `read_coach_brief` + `get_review_knowledge_snapshot` + `select_review_question_candidates` + `write_review_plan` only; no memory access (see §3.1) |
| narrow task surfaces | minimum task-specific tools only |

The three background agents should not necessarily have identical permissions.
They overlap heavily, but their purposes differ:

- Coach needs tools that help decide today's plan.
- Dreaming needs tools that reveal cross-context patterns and learner memory.
- Maintenance needs tools that repair substrate quality through proposals.

Copilot is the exception: it should feel fully capable to the user, while still
respecting proposal-only safety for destructive changes.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: U0 D7/D8 designated this spec
> as the single home of agent-tool governance. The subsections below are the
> authoritative statements; CO §10 / CO §1.6 and PS §4 reference them instead of
> restating.

### 3.1 Memory-Access Governance

Memory is an attention prior, not a source of truth — per
[ADR-0017](../../adr/0017-memory-mem0-plus-brief-layer.md), the SoT is the event
log plus the `knowledge_mastery` view; the Mem0 fact layer and the brief layer
only provide direction.

The `search_memory_facts` DomainTool is a thin wrapper over
`src/server/memory/client.ts` (the Mem0 backend — `mem0ai`, client / triggers /
scope_tagger / active-subjects — is already fully landed; the audit's
"not present" finding referred only to the agent-tool layer, which this tool
adds).

Grant / deny:

- **Granted**: `coach`, `dreaming`, `copilot` only (the orchestrator roles).
- **Denied**: evaluator and operator tasks — judge, tagging, structure,
  attribution, verification — plus `ReviewPlanTask`, `QuizGenTask`, and
  `KnowledgeReviewTask`. These never read memory.

Prohibited effects (apply to every memory consumer):

- memory never directly mutates `due` / `mastery` / FSRS state;
- memory never biases judgement (no scoring tilt);
- personalization signals reach planning only after being washed through the
  Coach brief and handed down a single channel — never read raw by tactical /
  generation tasks.

### 3.2 AI-Output Admission Rule (Blast Radius)

AI-produced records are admitted by blast radius:

- **Per-item measurement metadata** (e.g. `review_profile`, `coverage` rows) is
  **auto-active**, but must carry `confidence` + `provenance` and stay traceable
  and reversible (deactivate / override via `status`). Local scope, low blast
  radius, so it lands without a publish gate.
- **Global policy** (e.g. a subject profile) is **publish-gated**: it changes how
  many downstream items are scored / routed, so it requires an explicit publish
  step before it goes active.

CO §1.6 and PS §4 reference this rule rather than restating it.

### 3.3 Proposal-Only Invariant

The proposal-only invariant for destructive domain changes is owned by
[ADR-0025 ND-5](../../adr/0025-north-star-goal-entity-and-coach-coexistence.md)
(with [ADR-0004](../../adr/0004-pattern-c-two-type-agent-architecture.md)). This
spec's §1.2 references it; CO §11 and PS §4+§11 likewise reference it and keep
only their own surface-specific increments.

## 4. Task-To-Dreaming Notes

Add a small tool so narrow tasks can leave notes for future Dreaming and
Maintenance runs.

Conceptual tool:

```ts
leave_agent_note({
  target_agents: ['dreaming' | 'maintenance' | 'coach'],
  source_task_kind: string,
  source_task_run_id?: string,
  refs: Array<{ kind: string; id: string }>,
  summary_md: string,
  signal_kind: string,
  confidence?: number,
  expires_at?: string
})
```

MVP storage can be an event:

```text
event(
  action = 'experimental:agent_note',
  actor_kind = 'agent',
  actor_ref = source task,
  subject_kind = 'query',
  payload = {
    target_agents,
    refs,
    summary_md,
    signal_kind,
    confidence,
    expires_at
  }
)
```

Dreaming/Maintenance read these notes as extra context. The notes are not facts;
they are hints with provenance and expiry.

### 4.1 Two Channels: `needs[]` vs `leave_agent_note`

Narrow tasks have **two** distinct ways to signal upstream, and they do not
overlap:

- **`needs[]`** — structured, on the plan artifact. A task (e.g. `ReviewPlanTask`)
  declares unmet needs such as `question_profile_refresh` or
  `question_generation` directly on its output artifact, where the **next Coach
  round consumes them** as part of structured planning. This is the durable,
  plan-loop channel.
- **`leave_agent_note`** — an out-of-band hint with expiry (`expires_at`),
  consumed by background Dreaming / Maintenance runs. This is the soft,
  best-effort channel for cross-context observations that have no place on a
  specific plan artifact.

Both channels share the `signal_kind` vocabulary so the same observation can be
classified consistently regardless of which channel carries it.

## 5. Current Context Contract

Copilot input should include a compact current-context envelope:

```ts
type CurrentUserContext = {
  route: string;
  surface: string;
  subject_id?: string;
  active_refs: Array<{
    kind:
      | 'question'
      | 'question_part'
      | 'knowledge'
      | 'artifact'
      | 'learning_item'
      | 'goal'
      | 'review_paper'
      | 'conversation';
    id: string;
    part_ref?: string;
  }>;
  selection?: {
    text?: string;
    block_id?: string;
    figure_id?: string;
  };
  session_id?: string;
  recent_event_ids?: string[];
}
```

Routes provide the envelope; server readers expand it. Copilot should not
preload the whole world into every prompt.

## 6. Relationship To Existing Implementation

Current implementation already supports pieces of this:

- `CopilotTask`, `CoachTask`, and `DreamingTask` exist in `src/ai/registry.ts`.
- `src/server/ai/tools/allowlists.ts` defines current DomainTool surfaces.
- `runCopilotChat` builds an MCP bridge and records Copilot ask/trigger events.
- `runCoach` writes trigger/scan events and produces `TodayPlan`.
- `runDreamingNightly` runs the dreaming proposal loop.
- `learning_session(type='conversation')` exists for Active Teaching.

Known gaps:

- **Largest gap**: the Copilot chat composer is a frontend placeholder. The
  backend `runCopilotChat` is complete, but `TodayCopilotDrawer.tsx:107-109` does
  not yet wire a real composer/send path, so the user cannot actually drive
  Copilot from the UI. This blocks every other slice and is addressed by Slice 0.
- Copilot is still Today-shaped in product copy and context.
- Copilot tool surface is narrower than the desired full-agent product shape.
- Active Teaching is still a separate route/API/mental model.
- Copilot has no explicit current-context contract across all pages.
- No `leave_agent_note` tool exists.
- Background agent purposes are not encoded as skills/objectives in one place.

## 7. Implementation Slices

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: U0 D10 re-sequenced these
> slices. A new Slice 0 (chat composer) was added as the hidden prerequisite for
> everything else; Slice 2 and Slice 3 were split into `a`/`b` sub-steps to
> express the real ordering; Slice 4 was expanded to three chat surfaces with
> three protective constraints; and Slice 6 was reduced to a cross-reference now
> that the review-planning design lives in CO + ADR-0029.

### Execution Order

```text
S1 → (S0 ∥ S5) → S2a → S3a → S2b → S3b → S4
```

- **S1** first: docs + ADR-0004 marked superseded-in-product-shape.
- **S0 ∥ S5**: chat composer and background agent notes can run in parallel
  (S5 rides `ExperimentalEvent` with zero schema change).
- **S2a** (S): strip Today-specific copy.
- **S3a** (M): turn persistence + replay-last-N.
- **S2b** (L): `CurrentUserContext` v0 = route + a single `active_ref`
  (selection / multiple refs deferred to a later pass).
- **S3b** (L): rolling summary — behind a YAGNI gate, only built once a
  conversation genuinely overflows the context window.
- **S4** (XL) last.

### Slice 0 - Copilot Chat Composer

Size: M. This is the hidden prerequisite for every other AF slice — the backend
`runCopilotChat` is complete, but the frontend composer at
`TodayCopilotDrawer.tsx:107-109` is a placeholder, so the user cannot drive
Copilot yet. Coordinate with YUK-169 (7A has merged); build the composer in the
drawer mounted on the app shell.

### Slice 1 - Document And Skill Contracts

- Add this design record.
- Add agent skill/objective docs for Copilot, Coach, Dreaming, and Maintenance.
- Mark ADR-0004 as superseded in product shape, while preserving runner/tooling
  facts that still hold.

### Slice 2 - Global Copilot Context

**S2a** (S):

- Rename Today-specific Copilot copy where it is no longer Today-specific.

**S2b** (L):

- Define `CurrentUserContext` v0 = `route` + a single `active_ref`.
- Wire app shell/page surfaces to provide that v0 envelope.
- Add server-side current-context expansion tools.
- `selection` and multiple `active_refs` are a later pass, not part of v0.

### Slice 3 - Copilot Session And Compression

**S3a** (M):

- Reuse `learning_session(type='conversation')` for Copilot.
- Persist turns/events consistently; support replay-last-N.
- Keep Claude Agent SDK session use an implementation detail.

**S3b** (L, YAGNI-gated):

- Add rolling summary / auto-compression **only** when a conversation genuinely
  overflows the short context window. Do not build it speculatively.

### Slice 4 - Merge Chat Surfaces Into Copilot

Size: XL; runs last. The merge target is **three** chat surfaces, not two:

1. Active Teaching;
2. **SolveTutor** (YUK-193 — omitted from the original draft);
3. Copilot.

Convert their turn behaviors into Copilot skills and move the user-facing entry
to Copilot, subject to three protective constraints:

- **corrective-chip stays on its own endpoint** so its KPI accounting stays
  separated from Copilot chat;
- **`ask_check` raw INSERT keeps a narrow service path** and does not enter the
  Copilot tool surface;
- **legacy routes run in parallel during the migration window** rather than being
  cut over at once.

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: original Slice 4 merged only
> Active Teaching + Copilot. U0 D10 added the SolveTutor (YUK-193) surface and the
> three protective constraints above.

### Slice 6 - Coach Owns Review Planning

See the coach-led review-engine spec
(`2026-06-03-coach-led-review-engine-design.md`, "CO") and
[ADR-0029](../../adr/0029-review-engine-lands-on-existing-primitives.md) for the
Coach → brief → `ReviewPlanTask` pipeline (§2.2 above summarizes it).

> **Amended 2026-06-04 (U0 / YUK-205 / ADR-0029)**: this slice previously
> restated the review-planning design. U0 D10 de-duplicated it into the
> cross-reference above; the design itself is owned by CO + ADR-0029.

## 8. Non-Goals

- Public plugin platform.
- Raw DB editor tools.
- Multiple user-facing chat agents.
- Making every narrow task a full agent.
- Replacing all existing routes at once.

## 9. Summary

The new architecture is:

```text
User-facing:
  Copilot = global full agent + skills + automatic current context

Background:
  Coach = plan
  Dreaming = synthesize / remember / propose
  Maintenance = repair substrate

Execution:
  Narrow tasks = bounded workers with narrow tools

Shared substrate:
  Claude Agent SDK runner
  DomainTool registry
  learning_session/event logs
  proposal-only safety
  memory brief
  agent notes
```

This preserves the existing runner/tool substrate but changes the product shape:
the user talks to one Copilot; everything else either plans, dreams, maintains,
or executes bounded work behind the scenes.
