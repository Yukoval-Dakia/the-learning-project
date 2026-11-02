# L5.2 Proposal Inbox UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the split proposal inbox with a unified `/api/proposals` reader plus generic accept, dismiss, and retract lifecycle routes used by `app/(app)/inbox/page.tsx`.

**Architecture:** Keep `writeEvent()` as the only event writer. Add proposal lifecycle owner-service functions under `src/server/proposals/` that dispatch current implemented kinds (`knowledge_node`, `knowledge_edge`) to existing domain owner services, while future proposal kinds remain visible but accept-unsupported until YUK-44. The inbox reader treats rate events and correction events as lifecycle state so accepted/dismissed/retracted rows leave the pending queue.

**Tech Stack:** Next.js App Router route handlers, React Query, Zod, Drizzle/Postgres, Vitest DB tests, existing CSS primitives.

---

### Files

- Modify: `src/server/proposals/inbox.ts` - expose `getProposalInboxRow()` and hide corrected proposal events from pending.
- Create: `src/server/proposals/actions.ts` - owner-service lifecycle for accept, dismiss, and retract.
- Create: `src/server/proposals/actions.test.ts` - DB tests for node/edge/generic lifecycle paths.
- Create: `app/api/proposals/route.ts` - unified pending proposal API for the UI.
- Create: `app/api/proposals/route.test.ts` - API projection tests.
- Create: `app/api/proposals/[id]/accept/route.ts` - generic accept route.
- Create: `app/api/proposals/[id]/dismiss/route.ts` - generic dismiss route.
- Create: `app/api/proposals/[id]/retract/route.ts` - generic retract route.
- Create: `app/api/proposals/[id]/*/route.test.ts` - route tests for all three actions.
- Modify: `app/(app)/inbox/page.tsx` - use `/api/proposals?status=pending`, render mixed kinds, call the generic routes.
- Modify: `app/globals.css` - small class additions for unified proposal rows and retract controls.

### Task 1: Reader Lifecycle State

- [x] Add `getProposalInboxRow(db, id)` in `src/server/proposals/inbox.ts`.
- [x] Load correction status for proposal ids via `getCorrectionStatuses()`.
- [x] Map corrected proposal rows to `status='stale'` so `status=pending` excludes retracted rows without expanding legacy status API.
- [x] Add DB tests proving a correction event hides a proposal from the pending reader.
- [x] Run: `pnpm exec vitest run --config vitest.db.config.ts src/server/proposals/inbox.test.ts`

### Task 2: Lifecycle Owner Service

- [x] Add `acceptAiProposal(db, proposalId, opts)` in `src/server/proposals/actions.ts`.
- [x] Dispatch `knowledge_node` to `acceptProposal(db, proposalId)`.
- [x] Extract edge proposal logic from `app/api/knowledge/edges/proposals/[id]/route.ts` into `decideKnowledgeEdgeProposal(db, proposalId, opts)` and call it from `acceptAiProposal()` for edge accept/reverse/change_type.
- [x] Add `dismissAiProposal(db, proposalId, opts)` using existing node dismiss, edge dismiss, and generic RateEvent fallback for future kinds.
- [x] Add `retractAiProposal(db, proposalId, opts)` that writes `CorrectEvent(correction_kind='retract')` chained to the proposal event.
- [x] Keep future-kind accept unsupported with a 400-style domain error until YUK-44 owns producer semantics.
- [x] Run: `pnpm exec vitest run --config vitest.db.config.ts src/server/proposals/actions.test.ts app/api/knowledge/edges/proposals/[id]/route.test.ts app/api/knowledge/proposals/[id]/route.test.ts`

### Task 3: Generic Routes

- [x] Add `GET /api/proposals` with `status` and `limit` query params delegating to `listProposalInboxRows()`.
- [x] Add `POST /api/proposals/[id]/accept` using `acceptAiProposal()`.
- [x] Add `POST /api/proposals/[id]/dismiss` using `dismissAiProposal()`.
- [x] Add `POST /api/proposals/[id]/retract` using `retractAiProposal()`.
- [x] Preserve Next.js App Router route-handler style: `export const runtime = 'nodejs'`, `params: Promise<{ id: string }>`, `Response.json(...)`.
- [x] Run: `pnpm exec vitest run --config vitest.db.config.ts app/api/proposals/route.test.ts app/api/proposals/[id]/accept/route.test.ts app/api/proposals/[id]/dismiss/route.test.ts app/api/proposals/[id]/retract/route.test.ts`

### Task 4: Unified Inbox UI

- [x] Replace split proposal queries in `app/(app)/inbox/page.tsx` with `/api/proposals?status=pending&limit=200`.
- [x] Render one mixed queue grouped by kind labels, preserving existing edge graph and node card readability.
- [x] Add dismiss and retract actions for every row.
- [x] Keep edge-specific reverse/change_type controls routed through `/api/proposals/[id]/accept`.
- [x] Display future kinds with a stable generic card; accept disabled with "待接入" until YUK-44.
- [x] Run: `pnpm typecheck` and `pnpm lint`.

### Task 5: Verification And Linear Closeout

- [x] Run `pnpm audit:schema`.
- [x] Run `pnpm audit:partition`.
- [x] Run `pnpm test:db`.
- [x] Run browser QA for `/inbox`: page loads, pending mixed proposal rows render, accept/dismiss/retract controls mutate state without framework overlay or console errors.
- [ ] Update YUK-43 with PR link and verification evidence.
- [ ] Closeout gate: search for actionable follow-ups and either update/create Linear issues or record `No Linear issue needed`.

### Notes

- L5.3 owns remaining seven producer migrations and proposal signal/ranking tables.
- Existing legacy routes remain for compatibility; this slice only moves the inbox UI to the generic lifecycle.
- If accepting via async boss job becomes necessary, stop and write an ADR first. Current decision is synchronous owner-service mutation.
