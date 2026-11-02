# YUK-63 Abandoned Review Session Resume Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show abandoned review sessions and let the user resume one into `/review`.

**Architecture:** Add one owner-service transition in `src/server/session/review.ts`, expose it through `POST /api/review/sessions/[id]/reopen`, then wire `/learning-sessions` and `/review?session=` to reuse that transition.

**Tech Stack:** Next.js App Router, React client page, TanStack Query, existing `Review` session owner-service, Vitest DB route tests.

---

## Tasks

### Task 1: Design Lock

**Files:**
- Create: `docs/design/2026-05-25-abandoned-review-session-resume.md`

- [x] Record transition semantics, UI entrypoint, and no-schema boundary.

### Task 2: Owner-Service Transition

**Files:**
- Modify: `src/server/session/review.ts`
- Modify: `src/server/session/review.test.ts`

- [ ] Add `reopenAbandonedReviewSession(db, sessionId)`.
- [ ] Verify `abandoned -> started`, `ended_at=null`, version bump, and `review.reopened` job event.

### Task 3: API Route

**Files:**
- Create: `app/api/review/sessions/[id]/reopen/route.ts`
- Create: `app/api/review/sessions/[id]/reopen/route.test.ts`

- [ ] Route calls `Review.reopenAbandonedReviewSession`.
- [ ] Cover success, 404, and conflict on non-abandoned state.

### Task 4: UI Wiring

**Files:**
- Create: `app/(app)/learning-sessions/page.tsx`
- Modify: `app/(app)/review/page.tsx`
- Modify: `app/globals.css`

- [ ] List recent review sessions including abandoned rows.
- [ ] Add Resume button on abandoned rows.
- [ ] Let `/review?session=<id>` adopt started, resume paused, and reopen abandoned sessions.

### Task 5: Verification

- [ ] `pnpm exec vitest run --config vitest.db.config.ts src/server/session/review.test.ts app/api/review/sessions/[id]/reopen/route.test.ts app/api/learning-sessions/route.test.ts`
- [ ] `pnpm typecheck`
- [ ] `pnpm exec biome check <touched files>`
- [ ] Commit with `Closes YUK-63`.
