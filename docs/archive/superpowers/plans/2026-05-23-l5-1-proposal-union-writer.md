# L5.1 Proposal Union Writer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Land the typed `AiProposalPayload` envelope, one proposal writer, and one inbox reader for the existing knowledge node and knowledge edge producers.

**Architecture:** `writeEvent()` remains the single event write path. The new writer validates a shared `AiProposalPayload` and embeds it under `payload.ai_proposal` while preserving legacy top-level payload fields required by current `KnownEvent` parsing and existing inbox UI. The new reader projects pending/accepted/dismissed proposal events into unified inbox rows and exposes a legacy adapter for the current `/api/knowledge/proposals` route.

**Tech Stack:** TypeScript, Zod, Drizzle/Postgres, Vitest DB tests, existing event stream schema.

---

### Files

- Create: `src/core/schema/proposal.ts` - shared Zod schemas and inferred types for all 9 proposal kinds.
- Create: `src/core/schema/proposal.test.ts` - round-trip tests for every proposal kind and core validation failures.
- Create: `src/server/proposals/writer.ts` - validated event writer for proposal payloads.
- Create: `src/server/proposals/writer.test.ts` - DB tests for all writer kinds, plus current knowledge node / edge legacy compatibility.
- Create: `src/server/proposals/inbox.ts` - unified proposal reader plus legacy projection adapter.
- Create: `src/server/proposals/inbox.test.ts` - DB tests for pending/accepted/dismissed/stale projection.
- Modify: `src/server/knowledge/proposals.ts` - route `propose_new` writes through the shared writer; keep non-node tree mutations on the existing experimental path.
- Modify: `src/server/knowledge/propose_edge.ts` - write `knowledge_edge` proposals through the shared writer.
- Modify: `app/api/knowledge/proposals/route.ts` - delegate event projection to `listLegacyKnowledgeProposals()`.

### Task 1: Proposal Schema

- [x] Add `AiProposalPayload` as a `z.discriminatedUnion('kind', ...)` in `src/core/schema/proposal.ts`.
- [x] Keep current two producer changes strict:
  - `knowledge_node.proposed_change` requires `{ mutation: 'propose_new', name, parent_id }`.
  - `knowledge_edge.proposed_change` requires `{ from_knowledge_id, to_knowledge_id, relation_type, weight }`.
- [x] Keep future seven kinds conservative with non-empty object `proposed_change` so YUK-43/YUK-44 can tighten semantics without another envelope migration.
- [x] Add `parseAiProposalPayload(input)` and `aiProposalKinds`.
- [x] Test all 9 kinds in `src/core/schema/proposal.test.ts`.
- [x] Run: `pnpm exec vitest run --config vitest.unit.config.ts src/core/schema/proposal.test.ts`

### Task 2: Shared Writer

- [x] Add `writeAiProposal(db, input)` in `src/server/proposals/writer.ts`.
- [x] For `knowledge_node`, write `action='propose'`, `subject_kind='knowledge'`, legacy fields `name`, `parent_id`, `reasoning`, plus `ai_proposal`.
- [x] For `knowledge_edge`, write `action='propose'`, `subject_kind='knowledge_edge'`, legacy fields `from_knowledge_id`, `to_knowledge_id`, `relation_type`, `weight`, `reasoning`, plus `ai_proposal`.
- [x] For the seven future kinds, write `action='experimental:proposal'` with the full `AiProposalPayload`; this is only a generic escape-hatch path, not a new stable KnownEvent branch.
- [x] Test writer accepts every kind and persists parseEvent-compatible events.
- [x] Run: `pnpm exec vitest run --config vitest.db.config.ts src/server/proposals/writer.test.ts`

### Task 3: Inbox Reader

- [x] Add `listProposalInboxRows(db, opts)` in `src/server/proposals/inbox.ts`.
- [x] Read proposal candidates:
  - `action='propose'` for `subject_kind IN ('knowledge', 'knowledge_edge')`
  - `action LIKE 'experimental:knowledge_%'`
  - `action='experimental:proposal'`
- [x] Resolve latest chained rate event by `caused_by_event_id`.
- [x] Map rate payloads to `pending | accepted | dismissed | stale`.
- [x] Prefer `payload.ai_proposal` when present; derive a compatible `AiProposalPayload` for legacy proposal rows.
- [x] Add `listLegacyKnowledgeProposals(db, { status })` to preserve `/api/knowledge/proposals` response shape.
- [x] Run: `pnpm exec vitest run --config vitest.db.config.ts src/server/proposals/inbox.test.ts app/api/knowledge/proposals/route.test.ts`

### Task 4: Producer Migration

- [x] Update `writeKnowledgeProposeEvent()` propose_new branch to call `writeAiProposal()` with kind `knowledge_node`.
- [x] Keep the non-propose_new experimental tree mutation path untouched in this sub-PR.
- [x] Update `runEdgeProposeAndWrite()` to call `writeAiProposal()` with kind `knowledge_edge`.
- [x] Preserve existing duplicate-pending behavior by keeping top-level legacy fields available for current dedupe logic.
- [x] Run:
  - `pnpm exec vitest run --config vitest.db.config.ts src/server/knowledge/proposals.test.ts`
  - `pnpm exec vitest run --config vitest.db.config.ts src/server/knowledge/propose_edge.test.ts`

### Task 5: Verification And Linear Closeout

- [x] Run `pnpm typecheck`.
- [x] Run `pnpm lint`.
- [x] Run `pnpm audit:schema`.
- [x] Run `pnpm test:db`.
- [ ] Update YUK-42 with the PR link and verification evidence.
- [ ] Closeout gate: search for actionable follow-ups and either update/create Linear issues or record `No Linear issue needed`.

### Notes

- L5.2 owns UI changes and accept/dismiss/retract route consolidation; this plan only preserves current route behavior.
- L5.3 owns migrating the remaining seven producers and introducing proposal feedback signals.
- The generic `experimental:proposal` writer path is intentionally present so writer/reader tests cover all 9 union kinds, but current production producers use only `knowledge_node` and `knowledge_edge` here.
