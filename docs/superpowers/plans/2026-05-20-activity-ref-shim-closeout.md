# ActivityRef Shim Closeout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Foundation A compatibility bridge by making review submit accept and emit `ActivityRef` as the primary identity while preserving `question_id` / `mistake_id` only as temporary compatibility shims.

**Architecture:** Keep storage and FSRS policy question-only for this slice, matching ADR-0014's "C tempo, B interfaces" direction. Add one small server-side normalizer that maps submit wire identity to `{ activity_ref, question_id }`, reject unsupported activity kinds explicitly, then update `/api/review/submit` and the review page to use `activity_ref` as the new path.

**Tech Stack:** Next.js App Router route handlers, TypeScript, Zod, Drizzle, Vitest, existing `ActivityRef` schema in `src/core/schema/activity.ts`.

---

## Scope

In scope:

- `/api/review/submit` accepts `activity_ref` with `{ kind: 'question', id }`.
- Legacy `mistake_id` and `question_id` remain accepted by a named shim, not as the route's primary identity.
- Review UI submits `activity_ref` from the queue item.
- Submit responses include `review_event.activity_ref` while keeping `review_event.question_id` for current consumers.
- Tests cover helper behavior, API behavior, UI contract typing, and existing plan/due `activity_ref` output.
- `docs/superpowers/status.md` reflects that review plan/due/submit are bridged while storage remains question-backed.

Out of scope:

- Scheduling non-question activities.
- Adding `question_part` persistence or record scheduling.
- Changing `material_fsrs_state.subject_kind` semantics.
- Removing `question_id` or `mistake_id` compatibility fields.
- Moving attribution, variant generation, or maintenance jobs off question-only assumptions.
- Product NoteVerify.

## File Structure

- Create `src/server/review/activity-ref.ts`
  - Single owner for review-submit identity normalization.
  - Converts `activity_ref`, `question_id`, or `mistake_id` into `{ activity_ref, question_id }`.
  - Rejects non-`question` activity kinds for this slice.
  - Rejects conflicting identity fields during the compatibility window.

- Create `src/server/review/activity-ref.test.ts`
  - Fast unit tests for the normalizer without database setup.

- Modify `app/api/review/submit/route.ts`
  - Import `ActivityRef` Zod schema and `normalizeReviewSubmitActivityRef`.
  - Make `activity_ref`, `question_id`, and `mistake_id` optional identity inputs.
  - Use the normalizer once, then continue existing question-only DB logic through `questionId`.
  - Add `activity_ref` to `review_event` response.

- Modify `app/api/review/submit/route.test.ts`
  - Add `activity_ref` happy-path coverage.
  - Keep legacy `mistake_id` coverage.
  - Add validation coverage for missing identity, conflicting identity, and unsupported activity kind.

- Modify `app/(app)/review/page.tsx`
  - Add an `ActivityRef` type.
  - Add `activity_ref` to `PlanQueueItem`.
  - Send `activity_ref: current.activity_ref` in submit payload.

- Modify `app/api/review/plan/route.test.ts`
  - Keep the existing queue assertion and make it explicit that `activity_ref.id === question_id`.

- Modify `app/api/review/due/route.test.ts`
  - Keep the existing row assertion and make it explicit that `activity_ref.id === question_id`.

- Modify `docs/superpowers/status.md`
  - Update the Foundation A status line from "plan/due exposed" to "plan/due/submit bridged; storage remains question-backed".

## Task 1: Add The Review Submit ActivityRef Normalizer

**Files:**
- Create: `src/server/review/activity-ref.ts`
- Create: `src/server/review/activity-ref.test.ts`

- [ ] **Step 1: Write the failing normalizer tests**

Create `src/server/review/activity-ref.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/server/http/errors';
import { normalizeReviewSubmitActivityRef } from './activity-ref';

describe('normalizeReviewSubmitActivityRef', () => {
  it('uses activity_ref as the primary identity', () => {
    expect(
      normalizeReviewSubmitActivityRef({
        activity_ref: { kind: 'question', id: 'q1' },
      }),
    ).toEqual({
      activity_ref: { kind: 'question', id: 'q1' },
      question_id: 'q1',
    });
  });

  it('accepts legacy question_id during the compatibility window', () => {
    expect(normalizeReviewSubmitActivityRef({ question_id: 'q1' })).toEqual({
      activity_ref: { kind: 'question', id: 'q1' },
      question_id: 'q1',
    });
  });

  it('accepts legacy mistake_id during the compatibility window', () => {
    expect(normalizeReviewSubmitActivityRef({ mistake_id: 'q1' })).toEqual({
      activity_ref: { kind: 'question', id: 'q1' },
      question_id: 'q1',
    });
  });

  it('allows duplicate compatibility fields when all ids match', () => {
    expect(
      normalizeReviewSubmitActivityRef({
        activity_ref: { kind: 'question', id: 'q1' },
        question_id: 'q1',
        mistake_id: 'q1',
      }),
    ).toEqual({
      activity_ref: { kind: 'question', id: 'q1' },
      question_id: 'q1',
    });
  });

  it('rejects conflicting compatibility identities', () => {
    expect(() =>
      normalizeReviewSubmitActivityRef({
        activity_ref: { kind: 'question', id: 'q1' },
        question_id: 'q2',
      }),
    ).toThrow(ApiError);
  });

  it('rejects unsupported activity kinds', () => {
    expect(() =>
      normalizeReviewSubmitActivityRef({
        activity_ref: { kind: 'record', id: 'r1' },
      }),
    ).toThrow(ApiError);
  });

  it('requires one identity field', () => {
    expect(() => normalizeReviewSubmitActivityRef({})).toThrow(ApiError);
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run:

```bash
pnpm vitest run src/server/review/activity-ref.test.ts
```

Expected:

```text
FAIL  src/server/review/activity-ref.test.ts
Cannot find module './activity-ref'
```

- [ ] **Step 3: Implement the normalizer**

Create `src/server/review/activity-ref.ts`:

```ts
import { questionRef, type ActivityRefT } from '@/core/schema/activity';
import { ApiError } from '@/server/http/errors';

export interface ReviewSubmitIdentityInput {
  activity_ref?: ActivityRefT | null;
  question_id?: string | null;
  mistake_id?: string | null;
}

export interface NormalizedReviewSubmitActivityRef {
  activity_ref: ActivityRefT;
  question_id: string;
}

export function normalizeReviewSubmitActivityRef(
  input: ReviewSubmitIdentityInput,
): NormalizedReviewSubmitActivityRef {
  const activityRef = input.activity_ref ?? null;
  if (activityRef && activityRef.kind !== 'question') {
    throw new ApiError(
      'unsupported_activity_kind',
      `review submit currently supports question activities only; got ${activityRef.kind}`,
      400,
    );
  }

  const candidateIds = [
    activityRef?.id ?? null,
    input.question_id ?? null,
    input.mistake_id ?? null,
  ].filter((id): id is string => typeof id === 'string' && id.length > 0);

  if (candidateIds.length === 0) {
    throw new ApiError(
      'validation_error',
      'activity_ref, question_id, or mistake_id is required',
      400,
    );
  }

  const [questionId] = candidateIds;
  if (candidateIds.some((id) => id !== questionId)) {
    throw new ApiError(
      'validation_error',
      'activity_ref.id, question_id, and mistake_id must reference the same question',
      400,
    );
  }

  return {
    activity_ref: questionRef(questionId),
    question_id: questionId,
  };
}
```

- [ ] **Step 4: Run the normalizer tests and verify they pass**

Run:

```bash
pnpm vitest run src/server/review/activity-ref.test.ts
```

Expected:

```text
PASS  src/server/review/activity-ref.test.ts
```

- [ ] **Step 5: Commit Task 1**

```bash
git add src/server/review/activity-ref.ts src/server/review/activity-ref.test.ts
git commit -m "test: cover review activity ref normalization"
```

## Task 2: Wire ActivityRef Through Review Submit API

**Files:**
- Modify: `app/api/review/submit/route.ts`
- Modify: `app/api/review/submit/route.test.ts`

- [ ] **Step 1: Add failing API tests for ActivityRef submit**

In `app/api/review/submit/route.test.ts`, update the first happy-path body type and add these tests near the current validation tests:

```ts
  it('accepts activity_ref as the primary review identity', async () => {
    await seedQuestion('q1');

    const res = await POST(
      submitReq({
        activity_ref: { kind: 'question', id: 'q1' },
        rating: 'good',
        latency_ms: 5000,
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      review_event: {
        activity_ref: { kind: string; id: string };
        question_id: string;
        rating: string;
      };
    };

    expect(body.review_event.activity_ref).toEqual({ kind: 'question', id: 'q1' });
    expect(body.review_event.question_id).toBe('q1');
    expect(body.review_event.rating).toBe('good');

    const db = testDb();
    const events = await db
      .select()
      .from(event)
      .where(and(eq(event.action, 'review'), eq(event.subject_id, 'q1')));
    expect(events).toHaveLength(1);
  });

  it('returns 400 when activity_ref kind is not supported by the question adapter', async () => {
    const res = await POST(
      submitReq({
        activity_ref: { kind: 'record', id: 'r1' },
        rating: 'good',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('unsupported_activity_kind');
    expect(body.message).toContain('question activities only');
  });

  it('returns 400 when activity_ref conflicts with legacy identity fields', async () => {
    const res = await POST(
      submitReq({
        activity_ref: { kind: 'question', id: 'q1' },
        question_id: 'q2',
        rating: 'good',
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toContain('must reference the same question');
  });
```

Change the existing missing-id test from:

```ts
  it('returns 400 when mistake_id is missing', async () => {
    const res = await POST(submitReq({ rating: 'good' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('validation_error');
  });
```

to:

```ts
  it('returns 400 when review identity is missing', async () => {
    const res = await POST(submitReq({ rating: 'good' }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; message: string };
    expect(body.error).toBe('validation_error');
    expect(body.message).toContain('activity_ref, question_id, or mistake_id is required');
  });
```

- [ ] **Step 2: Run the API tests and verify they fail for the new path**

Run:

```bash
pnpm vitest run app/api/review/submit/route.test.ts
```

Expected:

```text
FAIL  app/api/review/submit/route.test.ts
expected 400 to be 200
```

The failure should be from the `activity_ref` happy path because the route still requires `mistake_id`.

- [ ] **Step 3: Update the submit route schema and identity resolution**

In `app/api/review/submit/route.ts`, add imports:

```ts
import { ActivityRef } from '@/core/schema/activity';
import { normalizeReviewSubmitActivityRef } from '@/server/review/activity-ref';
```

Replace the current identity field in `SubmitBody`:

```ts
  mistake_id: z.string().min(1),
```

with:

```ts
  activity_ref: ActivityRef.optional(),
  question_id: z.string().min(1).optional(),
  mistake_id: z.string().min(1).optional(),
```

Replace:

```ts
    const body = parsed.data;
    const now = new Date();
    const questionId = body.mistake_id;
```

with:

```ts
    const body = parsed.data;
    const now = new Date();
    const identity = normalizeReviewSubmitActivityRef(body);
    const questionId = identity.question_id;
```

In the JSON response, replace:

```ts
      review_event: {
        id: eventId,
        question_id: questionId,
        rating: body.rating,
```

with:

```ts
      review_event: {
        id: eventId,
        activity_ref: identity.activity_ref,
        question_id: questionId,
        rating: body.rating,
```

Also update the route header comment so it no longer says the route treats `mistake_id` as the primary path. The replacement comment should say:

```ts
// Post-Step-9:
//   1. Resolve review identity through ActivityRef first, with `question_id`
//      and `mistake_id` accepted only by the compatibility shim.
//   2. Read latest material_fsrs_state for that question.
//   3. Compute next FSRS state via ts-fsrs.
//   4. Write a `review` event (action='review', subject='question') via
//      writeEvent (single-owner per ADR-0005).
//   5. Upsert material_fsrs_state via upsertFsrsState (single-owner per
//      Step 9.A new module).
```

Replace the old `mistake_id` wire comment above `SubmitBody` with:

```ts
// New callers send `activity_ref`. `question_id` and `mistake_id` are accepted
// only as compatibility inputs while the storage/policy layer remains backed by
// question rows.
```

- [ ] **Step 4: Run submit tests and verify they pass**

Run:

```bash
pnpm vitest run app/api/review/submit/route.test.ts src/server/review/activity-ref.test.ts
```

Expected:

```text
PASS  src/server/review/activity-ref.test.ts
PASS  app/api/review/submit/route.test.ts
```

- [ ] **Step 5: Commit Task 2**

```bash
git add app/api/review/submit/route.ts app/api/review/submit/route.test.ts src/server/review/activity-ref.ts src/server/review/activity-ref.test.ts
git commit -m "feat: accept activity ref in review submit"
```

## Task 3: Move The Review UI Submit Path To ActivityRef

**Files:**
- Modify: `app/(app)/review/page.tsx`

- [ ] **Step 1: Update the client queue type**

In `app/(app)/review/page.tsx`, add this type above `interface PlanQueueItem`:

```ts
type ActivityRef = {
  kind:
    | 'question'
    | 'question_part'
    | 'record'
    | 'recall_prompt'
    | 'practice_log'
    | 'project_milestone'
    | 'open_inquiry';
  id: string;
};
```

Then update `PlanQueueItem` from:

```ts
interface PlanQueueItem {
  question_id: string;
  prompt_md: string;
```

to:

```ts
interface PlanQueueItem {
  activity_ref: ActivityRef;
  question_id: string;
  prompt_md: string;
```

- [ ] **Step 2: Update the submit payload**

Replace the submit body identity in `app/(app)/review/page.tsx` from:

```ts
          mistake_id: current.question_id,
```

to:

```ts
          activity_ref: current.activity_ref,
```

Keep `referenced_knowledge_ids: current.knowledge_ids` unchanged.

- [ ] **Step 3: Typecheck the UI change**

Run:

```bash
pnpm typecheck
```

Expected:

```text
Command exits 0.
```

- [ ] **Step 4: Commit Task 3**

```bash
git add 'app/(app)/review/page.tsx'
git commit -m "feat: submit review activity refs from UI"
```

## Task 4: Lock Existing Plan/Due ActivityRef Contracts

**Files:**
- Modify: `app/api/review/plan/route.test.ts`
- Modify: `app/api/review/due/route.test.ts`

- [ ] **Step 1: Make plan test assert the identity bridge invariant**

In `app/api/review/plan/route.test.ts`, after:

```ts
    expect(body.queue[0].activity_ref).toEqual({ kind: 'question', id: 'q1' });
```

add:

```ts
    expect(body.queue[0].activity_ref.id).toBe(body.queue[0].question_id);
```

- [ ] **Step 2: Make due test assert the identity bridge invariant**

In `app/api/review/due/route.test.ts`, after:

```ts
    expect(body.rows[0].activity_ref).toEqual({
      kind: 'question',
      id: body.rows[0].question_id,
    });
```

add:

```ts
    expect((body.rows[0].activity_ref as { id: string }).id).toBe(body.rows[0].question_id);
```

- [ ] **Step 3: Run the contract tests**

Run:

```bash
pnpm vitest run app/api/review/plan/route.test.ts app/api/review/due/route.test.ts app/api/review/submit/route.test.ts src/server/review/activity-ref.test.ts
```

Expected:

```text
PASS  src/server/review/activity-ref.test.ts
PASS  app/api/review/submit/route.test.ts
PASS  app/api/review/plan/route.test.ts
PASS  app/api/review/due/route.test.ts
```

- [ ] **Step 4: Commit Task 4**

```bash
git add app/api/review/plan/route.test.ts app/api/review/due/route.test.ts
git commit -m "test: lock review activity ref bridge contracts"
```

## Task 5: Update Foundation Status And Run Final Verification

**Files:**
- Modify: `docs/superpowers/status.md`

- [ ] **Step 1: Update the Foundation A status line**

In `docs/superpowers/status.md`, replace:

```md
🟡  老代码路径 question_id → ActivityRef shim    review plan/due 已暴露 activity_ref；其余 legacy call sites 待统一
```

with:

```md
🟡  老代码路径 question_id → ActivityRef shim    review plan/due/submit 已接入 activity_ref；question_id/mistake_id 仅作 compat/storage
```

- [ ] **Step 2: Run targeted tests**

Run:

```bash
pnpm vitest run src/server/review/activity-ref.test.ts app/api/review/submit/route.test.ts app/api/review/plan/route.test.ts app/api/review/due/route.test.ts
```

Expected:

```text
PASS  src/server/review/activity-ref.test.ts
PASS  app/api/review/submit/route.test.ts
PASS  app/api/review/plan/route.test.ts
PASS  app/api/review/due/route.test.ts
```

- [ ] **Step 3: Run repository typecheck**

Run:

```bash
pnpm typecheck
```

Expected:

```text
Command exits 0.
```

- [ ] **Step 4: Run local smoke against Docker DB**

Run:

```bash
pnpm db:migrate:local
pnpm dev:local
pnpm smoke:local
```

Expected:

```text
/api/health returns 200 with db_ok.
/api/review/due?limit=1 returns 200.
/api/mistakes?limit=1 returns 200.
/api/knowledge returns 200.
```

Stop the `pnpm dev:local` process after `pnpm smoke:local` passes.

- [ ] **Step 5: Run touched-file lint**

Run:

```bash
pnpm biome check src/server/review/activity-ref.ts src/server/review/activity-ref.test.ts app/api/review/submit/route.ts app/api/review/submit/route.test.ts app/api/review/plan/route.test.ts app/api/review/due/route.test.ts 'app/(app)/review/page.tsx' docs/superpowers/status.md
```

Expected:

```text
Checked 8 files in ...
No fixes applied.
```

- [ ] **Step 6: Commit Task 5**

```bash
git add docs/superpowers/status.md
git commit -m "docs: update activity ref shim status"
```

## Final PR Checklist

- [ ] Run `git status --short` and confirm only intentional files are changed.
- [ ] Run `git log --oneline --max-count=5` and confirm task commits are ordered clearly.
- [ ] Open a PR with title `Foundation A ActivityRef review submit bridge`.
- [ ] PR description includes:

```md
## Summary
- adds a review-submit ActivityRef normalizer
- accepts `activity_ref` in `/api/review/submit` while keeping `question_id` / `mistake_id` as compatibility inputs
- sends `activity_ref` from the review UI and returns it in `review_event`

## Verification
- pnpm vitest run src/server/review/activity-ref.test.ts app/api/review/submit/route.test.ts app/api/review/plan/route.test.ts app/api/review/due/route.test.ts
- pnpm typecheck
- pnpm db:migrate:local
- pnpm smoke:local
- pnpm biome check src/server/review/activity-ref.ts src/server/review/activity-ref.test.ts app/api/review/submit/route.ts app/api/review/submit/route.test.ts app/api/review/plan/route.test.ts app/api/review/due/route.test.ts 'app/(app)/review/page.tsx' docs/superpowers/status.md
```

## Self-Review

- Spec coverage:
  - ADR-0014 ActivityRef bridge: Task 1, Task 2, Task 3.
  - Existing question-only runtime preserved: Task 1 normalizer rejects non-question kinds, Task 2 continues through `questionId`.
  - Plan/due already expose `activity_ref`: Task 4 locks this contract.
  - Status doc updated: Task 5.

- Placeholder scan:
  - No placeholder tokens or open-ended implementation steps.
  - Non-question scheduling and compatibility field removal are explicitly out of scope.

- Type consistency:
  - `activity_ref` uses `ActivityRef` Zod schema on the route and `ActivityRefT` in the helper.
  - Normalized output uses `question_id` for existing DB code and `activity_ref` for the new wire path.
