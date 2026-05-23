# L3 Correction Read Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close YUK-40 by surfacing correction truth consistently across review, mistakes, and learning-item surfaces without changing correction write semantics.

**Architecture:** Add a read-only effective-truth layer that follows `supersede` chains. Keep `getCorrectionStatuses()` as the single-event status projection, and use the new read model only where callers need the terminal/effective event. Expose a small correction-state snapshot on API rows, then render that snapshot through one shared UI component.

**Tech Stack:** TypeScript, Drizzle/Postgres, Vitest DB tests, React server rendering tests.

**Spec Source:** `docs/superpowers/plans/2026-05-23-track2-and-foundation-closeout-phases.md` L3 plus Linear YUK-40.

---

## Task 1: Effective Truth Read Model

**Files:**
- Create: `src/server/review/effective-truth.ts`
- Create: `src/server/review/effective-truth.test.ts`

- [x] Add `getEffectiveTruth()` and `getEffectiveTruths()` for event ids.
- [x] Follow `supersede` replacement chains until an active/retracted/marked_wrong terminal state.
- [x] Detect missing replacement events and cycles with readable snapshots.
- [x] Cover supersede chain N>1 in DB tests.

---

## Task 2: API Projections

**Files:**
- Modify: `src/server/events/queries.ts`
- Modify: `src/server/records/mistakes.ts`
- Modify: `src/server/orchestrator/review.ts`
- Modify: `app/api/review/due/route.ts`
- Modify: `app/api/review/submit/route.ts`
- Modify: `app/api/learning-items/route.ts`

- [x] Attach correction snapshots to failure attempts and mistake projection rows.
- [x] Let chained judge/user_cause lookup use effective truth so superseded judge chains resolve to the replacement event.
- [x] Attach `last_failure_event` snapshots to review plan/due rows.
- [x] Attach source event correction snapshots to learning-item list rows when `source_ref` points at an event.
- [x] Keep retracted attempts out of the next review plan.

---

## Task 3: Shared Renderer

**Files:**
- Create: `src/ui/correction/CorrectionStateRenderer.tsx`
- Create: `src/ui/correction/CorrectionStateRenderer.test.ts`
- Modify: `app/(app)/events/[id]/page.tsx`
- Modify: `app/(app)/mistakes/page.tsx`
- Modify: `app/(app)/review/page.tsx`
- Modify: `app/(app)/learning-items/page.tsx`

- [x] Render active/retracted/marked_wrong/superseded snapshots through one component.
- [x] Replace the event detail page local correction badge mapping with the shared component.
- [x] Surface non-active correction states in mistakes, review, and learning-item lists.

---

## Task 4: Verification

**Commands:**
- [x] `pnpm typecheck`
- [x] `pnpm lint`
- [x] `pnpm exec vitest run --config vitest.db.config.ts src/server/review/effective-truth.test.ts app/api/mistakes/route.test.ts app/api/review/plan/route.test.ts app/api/review/due/route.test.ts app/api/learning-items/route.test.ts src/server/orchestrator/review.test.ts`
- [x] `pnpm exec vitest run src/ui/correction/CorrectionStateRenderer.test.ts`
- [x] `pnpm audit:schema`
- [x] `pnpm audit:partition`
- [x] `pnpm test`
