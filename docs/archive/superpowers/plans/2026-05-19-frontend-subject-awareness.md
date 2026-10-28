# N+1 Frontend Subject Awareness Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect `SubjectProfile.renderConfig` to the frontend and read paths so learning and review surfaces can render by subject instead of assuming wenyan.

**Architecture:** Keep the registry and profile implementation server-side. API read paths return a slim subject profile derived from the first knowledge id's effective domain, and UI helpers map that profile into stable class/style props. This is an additive response-shape change with no database migration and no renderer registry.

**Tech Stack:** TypeScript, React 19, Next.js 15 App Router, Drizzle, Zod, Vitest, Biome, existing `SubjectProfile` definitions.

---

## Summary

Bring the recently added `SubjectProfile.renderConfig` into the frontend and the review/learning-item read paths. Unknown or missing domain falls back to the default wenyan profile.

## Key Changes

- Add `src/ui/lib/subject.ts` to convert a slim subject profile into content class/style props.
- Add `subject_profile: { id, displayName, renderConfig }` to `GET /api/learning-items/[id]`.
- Add the same `subject_profile` to each `/api/review/plan` queue item.
- Apply subject-aware content props in learning item detail, review, and the teaching drawer.
- Expose KaTeX only as a CSS/data hook in this PR; do not implement formula rendering.

## Task Sequence

### Task 1: Subject UI Helper

- [ ] Write failing tests in `src/ui/lib/subject.test.ts`.
- [ ] Run `pnpm vitest run src/ui/lib/subject.test.ts` and verify it fails.
- [ ] Implement `src/ui/lib/subject.ts`.
- [ ] Run `pnpm vitest run src/ui/lib/subject.test.ts`.
- [ ] Commit `feat(ui): add subject render helper`.

### Task 2: Learning Item Detail Subject Profile

- [ ] Extend `app/api/learning-items/[id]/route.test.ts` with red tests for math and fallback profiles.
- [ ] Run `pnpm vitest run app/api/learning-items/[id]/route.test.ts -t 'GET /api/learning-items/[id]'` and verify it fails.
- [ ] Implement the additive `subject_profile` response.
- [ ] Run the same targeted test.
- [ ] Commit `feat(api): expose subject profile on learning item detail`.

### Task 3: Review Plan Queue Subject Profile

- [ ] Extend review plan tests for math/fallback queue profiles.
- [ ] Run `pnpm vitest run app/api/review/plan/route.test.ts src/server/orchestrator/review.test.ts` and verify failure.
- [ ] Add `subject_profile` to `PlanQueueItem` with batched effective-domain resolution.
- [ ] Run the same targeted tests.
- [ ] Commit `feat(review): include subject profile in review queue`.

### Task 4: UI Consumption

- [ ] Add helper smoke tests for component-facing props.
- [ ] Run `pnpm vitest run src/ui/lib/subject.test.ts` and verify failure.
- [ ] Update local TS interfaces and apply subject-aware content props in learning item detail, review, and `TeachingDrawer`.
- [ ] Run `pnpm typecheck` and `pnpm lint`.
- [ ] Commit `feat(ui): render learning surfaces with subject profiles`.

### Task 5: Final Verification

- [ ] Run `pnpm vitest run src/ui/lib/subject.test.ts app/api/learning-items/[id]/route.test.ts app/api/review/plan/route.test.ts src/server/orchestrator/review.test.ts`.
- [ ] Run `pnpm typecheck`.
- [ ] Run `pnpm lint`.

## Public Interfaces

```ts
type SlimSubjectProfile = {
  id: string;
  displayName: string;
  renderConfig: {
    font_family: string;
    notation: string | null;
    code_highlight: string | null;
  };
};
```

- `/api/learning-items/[id]` adds top-level `subject_profile`.
- `/api/review/plan` adds `subject_profile` per `queue[]` item.
- Both changes are additive.

## Assumptions

- `knowledge_ids[0]` is the profile source for now.
- Multi-domain learning items are out of scope.
- No DB migration, no new subject, and no renderer registry in this PR.
