# Foundation Closeout + Correction Event Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the remaining Foundation A/B drift after ADR-0014 and start Foundation C with a first-class correction event substrate.

**Architecture:** Keep this phase narrow. Existing question-based runtime remains compatible, but new read contracts expose `ActivityRef` beside legacy `question_id`. Subject-specific AI prompts are routed through `SubjectProfile` instead of static wenyan strings. Correction events are introduced as append-only KnownEvents plus projection helpers; the first UI surface is event detail status/actions, not a full proposal-inbox rewrite.

**Tech Stack:** TypeScript, Zod, Next.js App Router, Drizzle, Vitest, Biome, existing `event` table and ADR-0014 schemas.

---

## Scope

This is the next shippable slice after PR #60 and PR #63. It deliberately does not implement `semantic`, `external_judge`, `question_part`, KaTeX rendering, or the unified proposal inbox. Those belong to later N+2/Product Track plans after this substrate is stable.

## Current Preconditions

- Working tree currently has subject-awareness cleanup in:
  - `app/(app)/learning-items/[id]/page.tsx`
  - `src/ui/lib/subject.ts`
  - `src/ui/lib/subject.test.ts`
  - `docs/agents/domain.md`
  - `docs/planning/v0.3-generalized-ai-learning-framework.md`
- Treat those as the immediate cleanup commit before starting new Foundation work.
- `docs/superpowers/status.md` is the phase tracker; update it only after implementation is verified.

## File Structure

### Modify

| File | Responsibility |
| --- | --- |
| `src/server/orchestrator/review.ts` | Add `activity_ref` to `PlanQueueItem` while keeping `question_id` compat. |
| `app/api/review/plan/route.test.ts` | Verify API exposes both legacy `question_id` and new `activity_ref`. |
| `src/server/orchestrator/review.test.ts` | Verify orchestrator output uses `questionRef(question_id)`. |
| `app/api/review/due/route.ts` | Add `activity_ref` to due-row compat response. |
| `app/api/review/due/route.test.ts` | Lock the due response shape. |
| `src/ai/task-prompts.ts` | Add profile-aware prompts for AttributionTask and graph proposal tasks. |
| `src/ai/task-prompts.test.ts` | Ensure math prompts do not contain wenyan-only source/example rules. |
| `src/server/boss/handlers/attribution_followup.ts` | Pass the resolved subject profile into AttributionTask. |
| `src/server/boss/handlers/knowledge_propose_nightly.ts` | Pass the resolved subject profile into KnowledgeProposeTask. |
| `src/server/boss/handlers/knowledge_edge_propose_nightly.ts` | Pass the resolved subject profile into KnowledgeEdgeProposeTask or document why graph-wide context falls back to default. |
| `src/core/schema/event/known.ts` | Add `CorrectEvent` KnownEvent branch. |
| `tests/schema/event.test.ts` | Add correction event schema coverage. |
| `src/server/events/corrections.ts` | New projection helper for active/retracted/superseded status. |
| `src/server/events/corrections.test.ts` | Unit tests for correction status semantics. |
| `src/server/events/queries.ts` | Apply correction status where event read paths project active truth. |
| `src/server/events/queries.test.ts` | Verify retracted/superseded events are annotated or filtered as intended. |
| `app/api/events/[id]/route.ts` | Return correction status and chained correction events. |
| `app/api/events/[id]/route.test.ts` | Lock event detail correction response. |
| `app/api/events/[id]/correct/route.ts` | Add deterministic write route for user-authored corrections. |
| `app/api/events/[id]/correct/route.test.ts` | Verify write route validates target event and payload. |
| `app/(app)/events/[id]/page.tsx` | Show correction status and minimal action controls. |
| `docs/superpowers/status.md` | Mark completed checkboxes only after verification. |

### Create

| File | Responsibility |
| --- | --- |
| `src/server/events/corrections.ts` | Pure correction projection helpers. |
| `src/server/events/corrections.test.ts` | Correction semantics tests. |
| `app/api/events/[id]/correct/route.ts` | Append-only correction writer. |

---

## Task 0: Clean Current Subject-Awareness Tail

**Files:**
- Modify: existing dirty files listed in Current Preconditions
- Test: `src/ui/lib/subject.test.ts`

- [ ] **Step 0.1: Verify current subject helper fix**

Run:

```bash
pnpm vitest run src/ui/lib/subject.test.ts
```

Expected: PASS.

- [ ] **Step 0.2: Typecheck the touched UI code**

Run:

```bash
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 0.3: Commit the cleanup before new work**

Run:

```bash
git add "app/(app)/learning-items/[id]/page.tsx" src/ui/lib/subject.ts src/ui/lib/subject.test.ts docs/agents/domain.md docs/planning/v0.3-generalized-ai-learning-framework.md
git commit -m "fix(ui): preserve subject font over legacy content overrides"
```

Expected: one cleanup commit. Do not include this plan file unless the user explicitly wants a planning-doc commit.

---

## Task 1: ActivityRef Compatibility on Review Read Paths

**Files:**
- Modify: `src/server/orchestrator/review.ts`
- Modify: `src/server/orchestrator/review.test.ts`
- Modify: `app/api/review/plan/route.test.ts`
- Modify: `app/api/review/due/route.ts`
- Modify: `app/api/review/due/route.test.ts`

- [ ] **Step 1.1: Add failing orchestrator assertion**

In `src/server/orchestrator/review.test.ts`, extend the existing queue item assertion:

```typescript
expect(item.question_id).toBe('q1');
expect(item.activity_ref).toEqual({ kind: 'question', id: 'q1' });
```

Run:

```bash
pnpm vitest run src/server/orchestrator/review.test.ts -t "prioritizes"
```

Expected: FAIL because `activity_ref` is missing.

- [ ] **Step 1.2: Implement orchestrator compat field**

In `src/server/orchestrator/review.ts`:

```typescript
import { type ActivityRefT, questionRef } from '@/core/schema/activity';
```

Extend `PlanQueueItem`:

```typescript
activity_ref: ActivityRefT;
```

When building both new and due rows, set:

```typescript
activity_ref: questionRef(n.question_id),
```

and:

```typescript
activity_ref: questionRef(r.question_id),
```

Run:

```bash
pnpm vitest run src/server/orchestrator/review.test.ts
```

Expected: PASS.

- [ ] **Step 1.3: Lock API response shape**

In `app/api/review/plan/route.test.ts`, assert:

```typescript
expect(body.queue[0].activity_ref).toEqual({ kind: 'question', id: body.queue[0].question_id });
```

Run:

```bash
pnpm vitest run app/api/review/plan/route.test.ts
```

Expected: PASS after Step 1.2.

- [ ] **Step 1.4: Add ActivityRef to `/api/review/due` compat rows**

In `app/api/review/due/route.ts`, import `questionRef` and add:

```typescript
activity_ref: questionRef(row.question_id),
```

to every returned row while keeping `id` and `question_id`.

In `app/api/review/due/route.test.ts`, assert:

```typescript
expect(body.rows[0].activity_ref).toEqual({ kind: 'question', id: body.rows[0].question_id });
```

Run:

```bash
pnpm vitest run app/api/review/due/route.test.ts
```

Expected: PASS.

- [ ] **Step 1.5: Commit**

```bash
git add src/server/orchestrator/review.ts src/server/orchestrator/review.test.ts app/api/review/plan/route.test.ts app/api/review/due/route.ts app/api/review/due/route.test.ts
git commit -m "feat(review): expose ActivityRef on review read paths"
```

---

## Task 2: Profile-Aware Remaining AI Prompts

**Files:**
- Modify: `src/ai/task-prompts.ts`
- Modify: `src/ai/task-prompts.test.ts`
- Modify: `src/server/boss/handlers/attribution_followup.ts`
- Modify: `src/server/boss/handlers/attribution_followup.test.ts`
- Modify: `src/server/boss/handlers/knowledge_propose_nightly.ts`
- Modify: `src/server/boss/handlers/knowledge_propose_nightly.test.ts`
- Modify: `src/server/boss/handlers/knowledge_edge_propose_nightly.ts`
- Modify: `src/server/boss/handlers/knowledge_edge_propose_nightly.test.ts`

- [ ] **Step 2.1: Add failing prompt tests**

In `src/ai/task-prompts.test.ts`, add math-profile expectations:

```typescript
it('builds subject-specific AttributionTask prompts', () => {
  const prompt = getTaskSystemPrompt('AttributionTask', resolveSubjectProfile('math'));
  expect(prompt).toContain('科目上下文：数学');
  expect(prompt).toContain('数学定义、定理、条件');
  expect(prompt).not.toContain('文言文');
});

it('builds subject-specific KnowledgeProposeTask prompts', () => {
  const prompt = getTaskSystemPrompt('KnowledgeProposeTask', resolveSubjectProfile('math'));
  expect(prompt).toContain('科目上下文：数学');
  expect(prompt).not.toContain('虚词');
});
```

Run:

```bash
pnpm vitest run src/ai/task-prompts.test.ts
```

Expected: FAIL because these tasks still return static registry prompts.

- [ ] **Step 2.2: Implement prompt builders**

In `src/ai/task-prompts.ts`, add three concrete builders:

- `buildAttributionPrompt(profile: SubjectProfile): string`
- `buildKnowledgeProposePrompt(profile: SubjectProfile): string`
- `buildKnowledgeEdgeProposePrompt(profile: SubjectProfile): string`

Required rules:
- Include `科目上下文：${profile.displayName}`.
- Derive cause category options from `profile.causeCategories.map((c) => c.id)`.
- Use `profile.grounding.requirement` and `profile.grounding.uncertaintyPolicy`.
- Do not hardcode wenyan-only examples.
- Preserve the existing JSON output contracts.

Extend `getTaskSystemPrompt()` switch for:

```typescript
case 'AttributionTask':
case 'KnowledgeProposeTask':
case 'KnowledgeEdgeProposeTask':
```

Run:

```bash
pnpm vitest run src/ai/task-prompts.test.ts src/ai/registry.test.ts
```

Expected: PASS. If `registry.test.ts` asserts old static wording, update it to assert invariant contract fields instead of wenyan examples.

- [ ] **Step 2.3: Pass subject profile from attribution worker**

In `src/server/boss/handlers/attribution_followup.ts`, resolve the effective domain from the attempt `referenced_knowledge_ids[0]`, then pass:

```typescript
subjectProfile: resolveSubjectProfile(domain)
```

in the `runTaskFn('AttributionTask', input, ctx)` context.

Add a test that seeds a math knowledge root, points the attempt at it, and expects:

```typescript
expect(runTaskFn.mock.calls[0]?.[2]).toMatchObject({
  subjectProfile: { id: 'math' },
});
```

Run:

```bash
pnpm vitest run src/server/boss/handlers/attribution_followup.test.ts
```

Expected: PASS.

- [ ] **Step 2.4: Pass subject profile from proposal workers**

For `knowledge_propose_nightly`, resolve the attempt's first referenced knowledge domain and pass `subjectProfile`.

For `knowledge_edge_propose_nightly`, use the dominant domain from recent failures if all failures resolve to one subject; otherwise pass the default profile and include a code comment explaining graph-wide mixed-subject context.

Run:

```bash
pnpm vitest run src/server/boss/handlers/knowledge_propose_nightly.test.ts src/server/boss/handlers/knowledge_edge_propose_nightly.test.ts
```

Expected: PASS.

- [ ] **Step 2.5: Commit**

```bash
git add src/ai/task-prompts.ts src/ai/task-prompts.test.ts src/server/boss/handlers/attribution_followup.ts src/server/boss/handlers/attribution_followup.test.ts src/server/boss/handlers/knowledge_propose_nightly.ts src/server/boss/handlers/knowledge_propose_nightly.test.ts src/server/boss/handlers/knowledge_edge_propose_nightly.ts src/server/boss/handlers/knowledge_edge_propose_nightly.test.ts
git commit -m "feat(ai): route remaining prompts through SubjectProfile"
```

---

## Task 3: CorrectEvent KnownEvent Schema

**Files:**
- Modify: `src/core/schema/event/known.ts`
- Modify: `tests/schema/event.test.ts`

- [ ] **Step 3.1: Add failing schema tests**

In `tests/schema/event.test.ts`, add:

```typescript
describe('CorrectEvent', () => {
  it('accepts retract correction with affected refs', () => {
    const result = KnownEvent.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'evt_bad',
      outcome: 'success',
      payload: {
        correction_kind: 'retract',
        reason_md: 'Wrong judge result attached to this attempt.',
        affected_refs: [{ kind: 'question', id: 'q1' }],
      },
    });
    expect(result.success).toBe(true);
  });

  it('requires replacement_event_id for supersede', () => {
    const result = KnownEvent.safeParse({
      actor_kind: 'user',
      actor_ref: 'self',
      action: 'correct',
      subject_kind: 'event',
      subject_id: 'evt_old',
      outcome: 'success',
      payload: {
        correction_kind: 'supersede',
        reason_md: 'New event has corrected content.',
        affected_refs: [{ kind: 'question', id: 'q1' }],
      },
    });
    expect(result.success).toBe(false);
  });
});
```

Run:

```bash
pnpm vitest run tests/schema/event.test.ts -t CorrectEvent
```

Expected: FAIL because `CorrectEvent` is not part of `KnownEvent`.

- [ ] **Step 3.2: Implement schema**

In `src/core/schema/event/known.ts`, import `ActivityRef`:

```typescript
import { ActivityRef } from '@/core/schema/activity';
```

Add:

```typescript
export const CorrectionKind = z.enum(['supersede', 'retract', 'mark_wrong', 'restore']);
export type CorrectionKindT = z.infer<typeof CorrectionKind>;

export const CorrectEvent = z
  .object({
    actor_kind: z.literal('user'),
    actor_ref: z.literal('self'),
    action: z.literal('correct'),
    subject_kind: z.literal('event'),
    subject_id: z.string(),
    outcome: z.literal('success'),
    payload: z.object({
      correction_kind: CorrectionKind,
      replacement_event_id: z.string().optional(),
      reason_md: z.string().min(1),
      affected_refs: z.array(ActivityRef).min(1),
    }),
    ...baseOptionalFields,
  })
  .superRefine((data, ctx) => {
    if (data.payload.correction_kind === 'supersede' && !data.payload.replacement_event_id) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "replacement_event_id is required when correction_kind='supersede'",
        path: ['payload', 'replacement_event_id'],
      });
    }
  });
export type CorrectEventT = z.infer<typeof CorrectEvent>;
```

Add `CorrectEvent` to the `KnownEvent` union near `RateEvent`.

Run:

```bash
pnpm vitest run tests/schema/event.test.ts -t CorrectEvent
```

Expected: PASS.

- [ ] **Step 3.3: Commit**

```bash
git add src/core/schema/event/known.ts tests/schema/event.test.ts
git commit -m "feat(events): add first-class correction event schema"
```

---

## Task 4: Correction Projection Helper

**Files:**
- Create: `src/server/events/corrections.ts`
- Create: `src/server/events/corrections.test.ts`
- Modify: `src/server/events/queries.ts`
- Modify: `src/server/events/queries.test.ts`

- [ ] **Step 4.1: Write helper tests**

Create `src/server/events/corrections.test.ts` with four explicit cases:

- Seed target `evt_a`, seed `correct/retract` targeting `evt_a`, call `getCorrectionStatus(db, 'evt_a')`, expect `{ state: 'retracted', correction_event_id: '<retract id>', replacement_event_id: null }`.
- Seed target `evt_a`, seed `correct/supersede` targeting `evt_a` with `replacement_event_id='evt_b'`, call `getCorrectionStatus(db, 'evt_a')`, expect `{ state: 'superseded', correction_event_id: '<supersede id>', replacement_event_id: 'evt_b' }`.
- Seed target `evt_a`, seed `correct/retract`, then later seed `correct/restore`, call `getCorrectionStatus(db, 'evt_a')`, expect `{ state: 'active', correction_event_id: null, replacement_event_id: null }`.
- Seed target `evt_a`, seed `correct/retract` targeting `evt_other`, call `getCorrectionStatus(db, 'evt_a')`, expect active status.

Run:

```bash
pnpm vitest run src/server/events/corrections.test.ts
```

Expected: FAIL because the helper does not exist.

- [ ] **Step 4.2: Implement helper**

Create `src/server/events/corrections.ts`:

```typescript
export type CorrectionStatus =
  | { state: 'active'; correction_event_id: null; replacement_event_id: null }
  | { state: 'retracted'; correction_event_id: string; replacement_event_id: null }
  | { state: 'marked_wrong'; correction_event_id: string; replacement_event_id: null }
  | { state: 'superseded'; correction_event_id: string; replacement_event_id: string };
```

Required exported functions:

```typescript
export async function getCorrectionStatus(db: Db, targetEventId: string): Promise<CorrectionStatus>;
export async function getCorrectionStatuses(db: Db, targetEventIds: string[]): Promise<Map<string, CorrectionStatus>>;
```

Semantics:
- Sort corrections by `created_at`, then `id`, ascending.
- `retract` => `retracted`.
- `mark_wrong` => `marked_wrong`.
- `supersede` => `superseded` with replacement id.
- `restore` => `active`.
- Unknown/malformed correction payloads are ignored only if they fail `KnownEvent.safeParse`; do not throw in read projections.

Run:

```bash
pnpm vitest run src/server/events/corrections.test.ts
```

Expected: PASS.

- [ ] **Step 4.3: Annotate event queries**

In `src/server/events/queries.ts`, expose correction status on single-event fetches and chain fetches without changing raw event rows:

```typescript
correction_status: CorrectionStatus;
```

For list projections that represent active truth, filter or tag as follows:
- `retracted` and `superseded`: excluded from active mistake/review projections.
- `marked_wrong`: retained in event history, excluded from correctness analytics.
- `active`: unchanged.

Run:

```bash
pnpm vitest run src/server/events/queries.test.ts tests/integration/mistake-readpath.test.ts
```

Expected: PASS.

- [ ] **Step 4.4: Commit**

```bash
git add src/server/events/corrections.ts src/server/events/corrections.test.ts src/server/events/queries.ts src/server/events/queries.test.ts tests/integration/mistake-readpath.test.ts
git commit -m "feat(events): project active status from correction events"
```

---

## Task 5: Event Detail Correction API + UI

**Files:**
- Modify: `app/api/events/[id]/route.ts`
- Modify: `app/api/events/[id]/route.test.ts`
- Create: `app/api/events/[id]/correct/route.ts`
- Create/modify: `app/api/events/[id]/correct/route.test.ts`
- Modify: `app/(app)/events/[id]/page.tsx`

- [ ] **Step 5.1: Add read API tests**

In `app/api/events/[id]/route.test.ts`, assert response contains:

```typescript
expect(body.event.correction_status).toEqual({
  state: 'active',
  correction_event_id: null,
  replacement_event_id: null,
});
expect(Array.isArray(body.chain.corrections)).toBe(true);
```

Run:

```bash
pnpm vitest run app/api/events/[id]/route.test.ts
```

Expected: FAIL until route uses correction helper.

- [ ] **Step 5.2: Implement read API**

Update `app/api/events/[id]/route.ts` to return:

```typescript
{
  event,
  correction_status,
  chain: {
    caused_by,
    caused_events,
    corrections,
  },
}
```

Keep existing fields intact for compatibility.

Run:

```bash
pnpm vitest run app/api/events/[id]/route.test.ts
```

Expected: PASS.

- [ ] **Step 5.3: Add write route tests**

Create tests for `POST /api/events/[id]/correct`:
- rejects missing `reason_md`;
- rejects `supersede` without `replacement_event_id`;
- writes `CorrectEvent` with `caused_by_event_id` set to the target event id;
- returns `{ correction_event_id }`.

Run:

```bash
pnpm vitest run app/api/events/[id]/correct/route.test.ts
```

Expected: FAIL until route exists.

- [ ] **Step 5.4: Implement write route**

Create `app/api/events/[id]/correct/route.ts`.

Rules:
- `runtime = 'nodejs'`.
- Validate target event exists.
- Validate request body:

```typescript
{
  correction_kind: 'supersede' | 'retract' | 'mark_wrong' | 'restore';
  replacement_event_id?: string;
  reason_md: string;
  affected_refs: Array<{ kind: string; id: string }>;
}
```

- Insert one `event` row:

```typescript
{
  actor_kind: 'user',
  actor_ref: 'self',
  action: 'correct',
  subject_kind: 'event',
  subject_id: targetEventId,
  outcome: 'success',
  payload,
  caused_by_event_id: targetEventId,
}
```

Run:

```bash
pnpm vitest run app/api/events/[id]/correct/route.test.ts
```

Expected: PASS.

- [ ] **Step 5.5: Minimal UI**

In `app/(app)/events/[id]/page.tsx`:
- Show correction state near the event header.
- Add actions for `retract`, `mark_wrong`, and `restore`.
- Use a small textarea for `reason_md`.
- Do not add `supersede` UI yet; it needs replacement-event selection.

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: PASS.

- [ ] **Step 5.6: Commit**

```bash
git add app/api/events/[id]/route.ts app/api/events/[id]/route.test.ts app/api/events/[id]/correct/route.ts app/api/events/[id]/correct/route.test.ts "app/(app)/events/[id]/page.tsx"
git commit -m "feat(events): add correction API and event detail controls"
```

---

## Task 6: Final Verification + Status Update

**Files:**
- Modify: `docs/superpowers/status.md`

- [ ] **Step 6.1: Run targeted tests**

```bash
pnpm vitest run src/ui/lib/subject.test.ts src/server/orchestrator/review.test.ts app/api/review/plan/route.test.ts app/api/review/due/route.test.ts src/ai/task-prompts.test.ts src/server/boss/handlers/attribution_followup.test.ts src/server/boss/handlers/knowledge_propose_nightly.test.ts src/server/boss/handlers/knowledge_edge_propose_nightly.test.ts tests/schema/event.test.ts src/server/events/corrections.test.ts src/server/events/queries.test.ts app/api/events/[id]/route.test.ts app/api/events/[id]/correct/route.test.ts tests/integration/mistake-readpath.test.ts
```

Expected: PASS.

- [ ] **Step 6.2: Run repo checks**

```bash
pnpm typecheck
pnpm lint
pnpm audit:schema
```

Expected:
- `typecheck`: PASS.
- `lint`: PASS.
- `audit:schema`: PASS, unless local `tsx` IPC sandbox issue appears; if it does, record exact error and rerun in the normal terminal environment before treating it as app failure.

- [ ] **Step 6.3: Update status**

In `docs/superpowers/status.md`:
- Mark Foundation A `ActivityRef shim` as partially/fully complete based on Task 1.
- Mark Foundation B remaining prompt work as complete only if Task 2 passed.
- Mark Foundation C `CorrectEventPayload as KnownEvent` complete.
- Mark projection/UI lines according to Tasks 4/5.

- [ ] **Step 6.4: Commit status**

```bash
git add docs/superpowers/status.md
git commit -m "docs(status): update Foundation closeout progress"
```

---

## Acceptance Criteria

- Review read paths expose `activity_ref` while preserving legacy `question_id`.
- Remaining high-use AI prompts do not hardcode wenyan-only behavior when a subject profile is available.
- `CorrectEvent` is a stable KnownEvent branch.
- Correction status can be projected deterministically from append-only events.
- Event detail API/UI can create and display retractions/mark-wrong/restores.
- Targeted tests, `pnpm typecheck`, and `pnpm lint` pass.

## Execution Choice

Recommended execution: **Inline Execution** for Task 0, then **Subagent-Driven** for Tasks 1-5 with one reviewer pass after each task. The write sets are separable enough to avoid conflicts if workers are assigned by task.
