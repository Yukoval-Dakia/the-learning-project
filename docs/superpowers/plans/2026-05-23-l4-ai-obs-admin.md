# L4 AI Observability Admin Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close YUK-41 by adding read-only admin surfaces for AI task runs, cost trend, and failure clusters.

**Architecture:** Keep the existing write path in `src/server/ai/log.ts` untouched. Add a server read model over `ai_task_runs`, `cost_ledger`, and `tool_call_log`, expose it through production-routable `/api/admin/*` endpoints, and render it in `/admin/*` pages protected by the existing browser `TokenGate`. The original Linear issue mentioned `app/api/_/admin/*`, but Next.js private-folder rules and the existing `/api/cost/today` precedent make `_` routes unsuitable for production UI dependencies.

**Tech Stack:** Next.js App Router, React 19, TanStack Query, Drizzle/Postgres, Vitest DB tests, existing Loom UI primitives.

**Spec Source:** Linear YUK-41 plus `docs/superpowers/plans/2026-05-23-track2-and-foundation-closeout-phases.md` §L4.

---

## Files

### Create
- `src/server/admin/ai-observability.ts` — read-only aggregation helpers and response types.
- `src/server/admin/ai-observability.test.ts` — DB tests for runs, cost trend, and failure clustering.
- `app/api/admin/runs/route.ts` — list recent runs with optional status/task filters.
- `app/api/admin/runs/[id]/route.ts` — single run timeline, including pg-boss job ids and tool-call timeline.
- `app/api/admin/cost/route.ts` — daily and task-kind cost series.
- `app/api/admin/failures/route.ts` — failure clusters grouped by finish reason and error-message prefix.
- `app/(admin)/layout.tsx` — admin shell using `TokenGate`.
- `app/(admin)/admin/runs/page.tsx`
- `app/(admin)/admin/cost/page.tsx`
- `app/(admin)/admin/failures/page.tsx`
- `src/ui/admin/observability.tsx` — shared client UI components/types for the three admin pages.
- `docs/agents/admin-surface.md` — route, auth, screenshot, and validation notes.

### Modify
- `docs/superpowers/plans/2026-05-23-l4-ai-obs-admin.md` — check off completed steps as work lands.
- Optionally `app/(app)/today/page.tsx` only if a small admin link is needed; default is no main-nav change.

---

## Task 1: Read Model + DB Tests

**Files:**
- Create: `src/server/admin/ai-observability.ts`
- Create: `src/server/admin/ai-observability.test.ts`

- [x] Implement `listAdminRuns(db, opts)` with limit/status/task_kind filters and cost/tool-call summaries.
- [x] Implement `getAdminRunTimeline(db, id)` returning the run, related cost ledger rows, pg-boss job ids, and tool calls ordered by time.
- [x] Implement `getAdminCost(db, opts)` returning daily series and per-task breakdown.
- [x] Implement `getAdminFailureClusters(db, opts)` grouping failed `ai_task_runs` by `{ finish_reason, error_prefix }`.
- [x] DB test: one run timeline includes pg-boss job id and tool-call timeline.
- [x] DB test: cost output includes daily totals and task-kind totals.
- [x] DB test: at least three failure samples cluster by finish reason + error prefix.

## Task 2: `/api/admin/*` Routes

**Files:**
- Create: `app/api/admin/runs/route.ts`
- Create: `app/api/admin/runs/[id]/route.ts`
- Create: `app/api/admin/cost/route.ts`
- Create: `app/api/admin/failures/route.ts`

- [x] Add thin route handlers that parse query params, call the read model, and return JSON.
- [x] Keep auth in `middleware.ts`; do not change matcher or exemptions.
- [x] Route tests are covered through read-model DB tests plus middleware tests; add route-specific tests only if query parsing becomes non-trivial.

## Task 3: Admin Route Group + UI

**Files:**
- Create: `app/(admin)/layout.tsx`
- Create: `src/ui/admin/observability.tsx`
- Create: `app/(admin)/admin/runs/page.tsx`
- Create: `app/(admin)/admin/cost/page.tsx`
- Create: `app/(admin)/admin/failures/page.tsx`

- [x] Add `app/(admin)/layout.tsx` wrapping children in `TokenGate` and an admin shell.
- [x] Add shared client UI with admin tabs, KPI strip, simple tables, timeline rows, cost bars, and failure cluster rows.
- [x] `/admin/runs` fetches `/api/admin/runs` and selected run detail from `/api/admin/runs/[id]`.
- [x] `/admin/cost` fetches `/api/admin/cost?days=30` and shows daily trend plus task-kind grouping.
- [x] `/admin/failures` fetches `/api/admin/failures` and shows clusters with sample run ids.
- [x] Verify missing token shows the existing `TokenGate` instead of admin content.

## Task 4: Docs + Screenshot

**Files:**
- Create: `docs/agents/admin-surface.md`

- [x] Document `/admin/runs`, `/admin/cost`, `/admin/failures`.
- [x] Document API paths `/api/admin/*`, INTERNAL_TOKEN behavior, and why `/api/_/admin/*` is intentionally not used.
- [x] Include one screenshot path generated during local browser verification.

## Task 5: Verification

- [x] `pnpm exec vitest run --config vitest.db.config.ts src/server/admin/ai-observability.test.ts`
- [x] `pnpm typecheck`
- [x] `pnpm lint`
- [x] `pnpm audit:schema`
- [x] `pnpm audit:partition`
- [x] `pnpm test`
- [x] Browser verification: start dev server, open `/admin/runs`, `/admin/cost`, `/admin/failures`, verify TokenGate and responsive layout.
