# YUK-62 ReviewIntent Banner Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users dismiss and refresh the `/review` session intent banner without adding server state.

**Architecture:** Extract a small `ReviewIntentBanner` component for render/test coverage. Keep persistence in the `/review` page via `localStorage`, scoped to today plus the exact intent string. Refresh reuses the existing TanStack Query path.

**Tech Stack:** Next.js client page, React 19, TanStack Query, Vitest render-to-string component tests, existing `Button` and `Icon` primitives.

---

## Tasks

### Task 1: Design Lock

**Files:**
- Create: `docs/design/2026-05-25-review-intent-banner.md`

- [x] Record dismiss scope, refresh behavior, stale marker, and no-event boundary.

### Task 2: Extract Banner Component

**Files:**
- Create: `src/ui/components/ReviewIntentBanner.tsx`
- Create: `src/ui/components/ReviewIntentBanner.test.tsx`

- [ ] Render intent text, dismiss and refresh icon buttons, refreshing state, and stale marker.
- [ ] Cover normal, refreshing, and stale render states with `renderToString`.
- [ ] Run `pnpm vitest run --config vitest.unit.config.ts src/ui/components/ReviewIntentBanner.test.tsx`.

### Task 3: Wire `/review`

**Files:**
- Modify: `app/(app)/review/page.tsx`

- [ ] Store dismiss state in `localStorage` as `{ date, intent }`.
- [ ] Hide the banner only when the stored date is today and the stored intent equals the current intent.
- [ ] Refresh clears local dismiss state and calls `intentQ.refetch()`.
- [ ] Run `pnpm typecheck`.

### Task 4: CSS And Gate

**Files:**
- Modify: `app/globals.css`

- [ ] Extend the existing `.review-intent` block for icon actions and stale marker.
- [ ] Run `pnpm lint` and focused component tests.
- [ ] Commit with `Closes YUK-62`.
