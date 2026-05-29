# T-D2 — DomainTool Registry M2 Read Tools Driver

> Driver doc for Wave 2 parallel track B. This prepares Foundation D M2 read-tool coverage after M1 shipped registry + bridge + 3 read tools.

**Date**: 2026-05-27  
**Project**: Foundation D — Copilot Orchestrator + DomainTool Registry  
**Milestone**: M2 — DomainTool read tools full coverage  
**Linear**: YUK-102 parent; YUK-103 / YUK-104 / YUK-105 / YUK-106 lanes  
**Source spec**:
- `docs/superpowers/specs/2026-05-17-agent-context-tools-design.md` §Read tool specs and §Engineering Sequence step 5
- `docs/planning/v0.4-complete-form-roadmap.md` §8.1
- `docs/superpowers/plans/2026-05-27-master-roadmap.md` Card T-D2

## Current baseline

M1 is shipped in code and docs:

- `query_mistakes`
- `query_events`
- `get_attempt_context`
- registry / bridge / `tool_call_log` / `experimental:tool_use` mirror

Wave 2 M2 fills the remaining read-tool surface needed by Drawer, Dreaming, and Coach.

## Lane split

### Lane A — Knowledge graph readers

**Linear**: YUK-103

**Tools**:
- `get_subject_graph_overview`
- `query_knowledge`
- `expand_knowledge_subgraph`
- `find_knowledge_paths`

**Acceptance**:
- Each tool has input/output zod schema, summary text, registry registration, and unit tests.
- Queries reuse existing knowledge tree/edge helpers where available.
- No tool invents relation semantics outside ADR-0010 / `docs/modules/knowledge.md`.

### Lane B — Record and question context readers

**Linear**: YUK-104

**Tools**:
- `query_records`
- `get_record_context`
- `get_question_context`

**Acceptance**:
- `query_records` reads `learning_record`, not retired `study_log`.
- Context tools compose existing owner read paths and return bounded payloads.
- Tool summaries are safe for user-visible Copilot cards.

### Lane C — Review and learning item context readers

**Linear**: YUK-105

**Tools**:
- `get_review_due`
- `get_learning_item_context`

**Acceptance**:
- `get_review_due` explains due-queue reasons without reimplementing FSRS scheduling.
- `get_learning_item_context` returns enough context for TeachingTurnTask / Copilot without hidden mutation.
- Optional use in task allowlists is documented but not wired into UI unless the lane explicitly owns that task.

### Lane D — Memory brief reader + allowlist/status closeout

**Linear**: YUK-106

**Tools**:
- `query_memory_brief`

**Scope**:
- Implement the reader against the Wave 1 brief writer tables/services.
- Update allowed tool policies for Copilot / TeachingTurnTask / Dreaming only where the spec already names them.
- Update Foundation D status docs and close M2 Linear issues.

**Acceptance**:
- `query_memory_brief` gracefully handles no brief, stale brief, and subject-scoped brief.
- `src/server/ai/tools/registry.test.ts` proves all M2 tools are registered.
- Status docs list 13 read tools with shipped/pending state accurately.

## Chain-merge order

Lane A -> Lane B -> Lane C -> Lane D.

Lane A can start in parallel with YUK-88 P1 because it should avoid artifact schema files. Re-check file overlap before launch.

## Gate

```bash
CODEX_FULL_GATE=1 pnpm typecheck
CODEX_FULL_GATE=1 pnpm lint
CODEX_FULL_GATE=1 pnpm audit:schema
CODEX_FULL_GATE=1 pnpm audit:partition
CODEX_FULL_GATE=1 pnpm audit:profile
CODEX_FULL_GATE=1 pnpm test
CODEX_FULL_GATE=1 pnpm build
```

## Boundaries

- No propose/write tools in T-D2; those belong to T-D4.
- No Copilot drawer UI in T-D2; drawer MVP is T-D3.
- No direct DB mutation except `tool_call_log` read-tool execution logging already owned by M1 infrastructure.
