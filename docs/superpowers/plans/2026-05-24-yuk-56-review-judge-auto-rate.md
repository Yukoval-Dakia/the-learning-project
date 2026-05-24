# YUK-56 — Review P2.1: connect judge router for auto-rating

**Track 1 / Wave 1 / Lane 5**. Parent: YUK-18 Review session UX polish.

## Scope (一句话)

Wire `JudgeInvoker`（YUK-39，CC-3）into `POST /api/review/submit` so exact / keyword auto-rate, semantic suggests; the review page surfaces the suggestion + lets the user override. CC-1 cause precedence preserved: user override of rating ≠ user override of cause; only the latter writes `experimental:user_cause`.

## Cross-cutting helpers (read first)

- **CC-1** `src/server/events/cause-policy.ts` — `effectiveCauseForFailureAttempt()`; **invariant**: active user_cause > active agent judge. **Implication**: this lane writes the agent `judge` event chained to the attempt; it never writes `user_cause` on rating-only overrides.
- **CC-3** `src/server/judge/invoker.ts` — `createDefaultJudgeInvoker()` is the only entrypoint; never call `judgeExact` / `judgeKeyword` / `judgeRouter` directly. Embedded-check is the reference site (`app/api/embedded-check/attempt/route.ts:75-94`).

## Backend design

### Wire shape (only additive — backwards compatible)

`POST /api/review/submit` request body (new optional fields):

```ts
{
  // existing fields (unchanged):
  activity_ref | question_id | mistake_id,
  rating: 'again'|'hard'|'good',                  // user's final rating (manual or override)
  response_md: string | null,
  latency_ms, session_id, referenced_knowledge_ids,
  // new (optional):
  auto_rate?: boolean,        // default false — when true, ignore `rating` and use judge suggestion
  override_of_judge?: boolean // default false — true ⇒ user saw judge suggestion and picked different rating
}
```

Response body (additive — new `judge` field):

```ts
{
  // existing fields:
  next_due_at, new_state, review_event,
  // new:
  judge?: {
    route: 'exact'|'keyword'|'semantic'|...,
    score: number | null,
    coarse_outcome: 'correct'|'partial'|'incorrect'|'unsupported',
    confidence: number,
    feedback_md: string,
    evidence_json: Record<string, unknown>,
    suggested_rating: 'again'|'hard'|'good' | null,   // null when unsupported
    capability_ref: { id: string; version: string },
    telemetry: { route, capability_ref, coarse_outcome, confidence, elapsed_ms, question_id, subject_id },
    judge_event_id: string,                            // id of chained 'judge' event written this txn
  } | null,                                            // null when response_md absent (manual-only path)
}
```

### Decision logic

1. **Trigger judge only when `response_md` is non-empty.** If the user submitted no answer (just rates from memory), skip judge entirely — no chained judge event, no `judge` in response.
2. **Resolve subject profile** via `resolveSubjectProfileForKnowledgeIds(db, q.knowledge_ids)` (matches embedded-check).
3. **Invoke** `createDefaultJudgeInvoker().invoke({ db, question: q, answer_md: body.response_md, subjectProfile })`.
4. **Map coarse_outcome → suggested rating** (Default decision, documented inline):
   - `correct` → `good` (no `easy` mapping — Review uses 3-state rating, not 4)
   - `partial` → `hard`
   - `incorrect` → `again`
   - `unsupported` → `null` (no suggestion; UI keeps manual flow)
5. **`auto_rate=true` flow** (UI-controlled): final rating = `suggested_rating`. If `suggested_rating === null` (unsupported), **reject with 422** so UI knows to fall through to manual.
6. **`auto_rate=false` flow** (default): final rating = `body.rating` (manual choice from UI; either matches suggestion or is user override).
7. **Write events in single transaction**:
   - `review` event (existing path, with `rating` = final rating)
   - **If judge was invoked** (response_md present): a chained `judge` event with `subject_kind='event' / subject_id=review_event_id`, `payload.cause = unknown`, `payload.judge_result = result`. Spec note: this lane stores the assessment trail; cause attribution is downstream (attribution_followup). We **do not** populate `payload.cause` here — that's the attribution job's role. Instead, we write the **assessment-trail** judge event with a `JudgeResultV2T` payload but null cause; the read-path picks it up by `caused_by_event_id=review_event_id`.

   **Wait — re-check schema.** `JudgeOnEvent` (`src/core/schema/event/known.ts`) requires `payload.cause`. The assessment-trail does not have a cause; that's a separate `attribution` agent_ref event. So we should NOT write `action='judge'` event from here. Instead we embed the judge result **inside the review event's payload** (mirroring embedded-check's `payload.judge`).

   **Final design**: do NOT write a separate `action='judge'` event. Add `payload.judge` (JudgeResultV2 shape) on the **review event itself**. This:
   - matches embedded-check's `payload.judge` pattern (`app/api/embedded-check/attempt/route.ts:122-126`)
   - avoids polluting `judge` event channel with assessment-only (no cause) events
   - keeps CC-1 clean: cause stays on `experimental:user_cause` + downstream `judge`-with-cause attribution events
8. **CC-1 invariant**: this route **never** writes `experimental:user_cause`. Cause overrides happen in a different UI flow (post-feedback "wrong cause" CTA, not in scope here).

### Identity / lookup

Need question row with `kind / prompt_md / reference_md / rubric_json / choices_md / judge_kind_override / knowledge_ids / metadata / figures / image_refs / structured`. Replace the current `SELECT id FROM question` with `SELECT * FROM question`.

### CC-3 compliance

Only call `createDefaultJudgeInvoker().invoke(...)`. Tests mock `runTask` (matches embedded-check pattern); invoker dispatches exact/keyword locally (no LLM) and semantic via SemanticJudgeTask (the mock target).

## Frontend design — UI pre-flight

### Design-doc citations

- `docs/design/2026-05-15-design-brief.md:98` — `/review` "FSRS due queue + 单题答 + 1/2/3 评分 + cause 显示". Spec mentions cause display from `events WHERE action='judge'` (auto-rating UX is **not** specified — this is the first concrete instance).
- `docs/audit/2026-05-22-drift-m3-closeout.md:40-46` — confirms `JudgeResultPanel` is the canonical judge feedback renderer (already mounted in EmbeddedCheckSection; reuse here per "no new abstractions without 2nd instance" — this is the 2nd, so reuse rather than create).
- `docs/audit/2026-05-22-partial-credit-trace.md:16` — `JudgeResultPanel` displays `score + capability label + appeal 按钮`.

**No design doc specifies auto-rating UX in /review.** Per CLAUDE.md "Don't introduce abstractions until a second concrete instance demands them": reuse `JudgeResultPanel` (EmbeddedCheckSection is 1st instance; review feedback is 2nd) without inventing a new component.

### Component types

- **page** (`app/(app)/review/page.tsx`): minor extension — feedback phase mounts `<JudgeResultPanel>` above the rating buttons when judge result returns; default-highlight the suggested rating button.

### Files touched

- **modify** `app/api/review/submit/route.ts` (backend wiring)
- **modify** `app/api/review/submit/route.test.ts` (new tests)
- **modify** `app/(app)/review/page.tsx` (feedback UI: mount JudgeResultPanel + highlight suggested rating)
- **create** `docs/superpowers/plans/2026-05-24-yuk-56-review-judge-auto-rate.md` (this file)

### UX flow

1. User types answer (existing).
2. Cmd+Enter → "进入对照" — UI calls existing reveal logic (no API call yet).
3. User picks rating button → POST `/api/review/submit` with `{ rating: chosen, response_md: answer, auto_rate: false }`.
4. Response includes `judge` (if answer was non-empty). UI **already advanced** to next question; judge result is currently ephemeral.

**Tweak**: on Cmd+Enter, ALSO immediately fire `/api/review/submit` with `auto_rate: true, rating: 'again'` (placeholder, ignored by server). Server returns `judge` + applies `suggested_rating` as final rating. UI displays `JudgeResultPanel` + 3 rating buttons highlighted on the suggestion; user can either:
- **Accept** (do nothing — already saved): just press Cmd+Enter again or Enter to go next.
- **Override**: click a different rating — UI fires a 2nd POST with `auto_rate: false, override_of_judge: true, rating: chosen`.

**Wait — that double-writes.** Simpler design:

**Single-shot v2**: Cmd+Enter does NOT save. It only reveals. User then picks rating (1/2/3) → POST `/api/review/submit` once with `{ rating, response_md, auto_rate: false }`. Server invokes judge anyway (for telemetry + future learning loop) and returns `judge` payload alongside the saved review_event. UI displays JudgeResultPanel post-save (feedback shown after rating).

But that means user picks rating BEFORE seeing judge suggestion. That's not "auto-rating" — that's "manual rating + post-hoc judge display".

**The actual minimal MVP for "auto-rating + override"** (matches Linear issue scope):
- Cmd+Enter → reveal (no API call, no judge call).
- A new **"自动判分"** button appears in feedback phase next to the 3 rating buttons.
- Click "自动判分" → POST with `auto_rate: true` → server invokes judge + writes review with suggested rating.
  - If `judge.suggested_rating === null` (unsupported), server returns 422 + UI keeps showing manual buttons.
- Click 1/2/3 manually → POST with `auto_rate: false` (current behaviour, except server also runs judge for telemetry + returns it in response for display before advancing).

That's the cleanest. Server-side: invoke judge whenever `response_md` is non-empty; auto_rate controls which rating wins.

UI flow finalised:

```
[feedback phase entered]
  ┌──────────────────────────────────┐
  │ feedback split (answer vs ref)   │
  │ cause row (existing)             │
  │ [自动判分] [不会] [模糊] [会了]    │  ← rating-row
  └──────────────────────────────────┘

[user clicks 自动判分 → POST auto_rate:true]
  if judge.coarse_outcome === 'unsupported':
    show "无法自动判分，请手动评" + keep buttons
  else:
    POST returns + UI shows JudgeResultPanel + saves with suggested_rating
    + auto-advances to next question (existing flow)

[user clicks 1/2/3 directly → POST auto_rate:false]
  judge still runs (server-side) but result is shown in JudgeResultPanel briefly
  + auto-advances (existing flow)
```

For MVP, the JudgeResultPanel display flashes too fast on auto-advance. The cleanest is: **don't auto-advance when judge ran** — show JudgeResultPanel + add a "下一题" Cmd+Enter CTA. But that breaks existing UX flow.

**Decision (autonomous, documented)**: Keep auto-advance. Display judge result inline for ~3s before advance. Cleaner: just render JudgeResultPanel on top of the next question's prompt area as a "previous question judge result" toast / banner. Out of MVP scope.

**Actual MVP scope** (final): server invokes judge when `response_md` non-empty; returns it in response. UI in this PR ONLY adds:
1. "自动判分" button that POSTs `auto_rate:true` and uses the suggested rating
2. After response returns, if `judge.suggested_rating !== rating chosen`, log to console (placeholder for future "your rating differed from auto" UX in YUK-58 timeline)
3. Mount JudgeResultPanel briefly in current feedback phase (just before advance) — simple `if (latestJudge) <JudgeResultPanel … />`

If render-flash is bad UX, follow-up issue captures it; this PR delivers the wiring + write path + suggested-rating mapping + override correctness.

## Tests (`app/api/review/submit/route.test.ts` additions)

1. **exact judge auto-rate correct → rating='good'** — seed question with `reference_md='答案'`, `kind='fill_blank'`; POST `{auto_rate:true, response_md:'答案'}`; assert review event written with `fsrs_rating='good'`, response includes `judge.route='exact'`, `judge.suggested_rating='good'`, `payload.judge` on review event.
2. **exact judge auto-rate wrong → rating='again'** — same seed, answer '错'; assert `fsrs_rating='again'`, `event.outcome='failure'`.
3. **keyword judge partial → rating='hard'** — seed with `kind='fill_blank'`, `judge_kind_override='keyword'`, `rubric_json.keywords=[a,b,c]`; partial-match answer; assert `suggested_rating='hard'`, `fsrs_rating='hard'`.
4. **semantic judge with mocked runTask** — seed with `judge_kind_override='semantic'`; mock runTask to return JSON; assert `suggested_rating` correctly mapped + runTask called.
5. **unsupported judge auto-rate → 422** — seed semantic question; mock runTask to throw → unsupported result; POST auto_rate:true → assert 422 `unsupported_judge_route`.
6. **manual override (auto_rate=false)** — POST with `rating='again', response_md='答案'` (exact correct judge); assert review event saved with `rating='again'` (user wins), but `payload.judge.suggested_rating='good'` (judge still ran). CC-1 invariant: no `experimental:user_cause` event written.
7. **no answer (response_md null) → no judge invoked** — POST `{rating:'good', response_md:null}`; assert no `judge` in response, no judge result in payload.
8. **CC-3 invariant**: judge invocation goes through `createDefaultJudgeInvoker` (verified by spy on internal — or by checking `payload.judge.telemetry.subject_id` populates correctly which only happens via invoker).
9. **existing tests still pass** — backwards compat: all current tests POST without `auto_rate` and without `response_md` (or with response_md); assert behaviour unchanged for default path.

## Pre-merge gate

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm audit:schema
pnpm audit:partition
pnpm audit:profile
pnpm test:db   # covers new route tests
```

## Not in scope (explicit)

- ❌ User cause override (separate UI flow — YUK-18 child P3 or future)
- ❌ Appeal button on review judge result (M2.3 appeal path is question-scoped; review-flow appeal not wired)
- ❌ Timeline / attempt-history UI (YUK-58)
- ❌ FSRS scheduling changes (existing path)
- ❌ Performance optimisations (no caching, no batching)
- ❌ New `judge` event channel writes (assessment trail embedded in review event payload, not a separate row)
