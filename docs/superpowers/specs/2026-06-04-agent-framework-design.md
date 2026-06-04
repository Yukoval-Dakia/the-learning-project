# Agent Framework Design - global Copilot, skills, and background agents

> **Status**: design record, 2026-06-04.
> **Context**: follow-up to the 2026-06-03 product architecture discussion.
> Existing ADR-0004 splits "Backend Purpose Agent" and "User Copilot", but that
> document predates the current product decision: Copilot should become the
> single user-facing full agent, while Coach / Dreaming / Maintenance become
> specialized background agents with clear purposes.

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

Safety still applies:

- destructive domain changes are proposal-only unless an existing user-confirmed
  route owns the mutation;
- raw database mutation is not a Copilot capability;
- draft-layer edits may be direct only on surfaces explicitly designed for that
  user-triggered edit.

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

The review-engine design moves more authority to Coach: Coach should eventually
select knowledge focus, choose question candidates, and adapt later paper
sections from hidden judgement evidence.

Coach output should be structured artifacts such as `TodayPlan` and future
`ReviewPlan`, not free-form chat history.

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
| narrow task surfaces | minimum task-specific tools only |

The three background agents should not necessarily have identical permissions.
They overlap heavily, but their purposes differ:

- Coach needs tools that help decide today's plan.
- Dreaming needs tools that reveal cross-context patterns and learner memory.
- Maintenance needs tools that repair substrate quality through proposals.

Copilot is the exception: it should feel fully capable to the user, while still
respecting proposal-only safety for destructive changes.

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

- Copilot is still Today-shaped in product copy and context.
- Copilot tool surface is narrower than the desired full-agent product shape.
- Active Teaching is still a separate route/API/mental model.
- Copilot has no explicit current-context contract across all pages.
- No `leave_agent_note` tool exists.
- Background agent purposes are not encoded as skills/objectives in one place.

## 7. Implementation Slices

### Slice 1 - Document And Skill Contracts

- Add this design record.
- Add agent skill/objective docs for Copilot, Coach, Dreaming, and Maintenance.
- Mark ADR-0004 as superseded in product shape, while preserving runner/tooling
  facts that still hold.

### Slice 2 - Global Copilot Context

- Define `CurrentUserContext`.
- Wire app shell/page surfaces to provide current context.
- Add server-side current-context expansion tools.
- Rename Today-specific Copilot copy where it is no longer Today-specific.

### Slice 3 - Copilot Session And Compression

- Reuse `learning_session(type='conversation')` for Copilot.
- Persist turns/events consistently.
- Add rolling summary/auto-compression.
- Keep Claude Agent SDK session use an implementation detail.

### Slice 4 - Merge Active Teaching Into Copilot

- Convert TeachingTurn behavior into a Copilot skill.
- Keep teaching session compatibility while moving user-facing entry to Copilot.
- Preserve `ask_check` persistence and solve/teaching subject prompts.

### Slice 5 - Background Agent Notes

- Add `leave_agent_note`.
- Teach narrow tasks when to leave notes.
- Add Dreaming/Maintenance readers for recent agent notes.

### Slice 6 - Coach Owns Review Planning

- Connect the Coach-led review engine to Coach's structured planning output.
- Keep deterministic due/FSRS as compatibility pressure only.
- Let Copilot explain or negotiate plans, but keep Coach as planner.

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
