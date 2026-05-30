# YUK-145 T-OC Slice 1 — Generalized Capture (the MODEL fix) — Lane Plan

> Written fresh against `main @ 91832bc1` in worktree `/private/tmp/tlp-yuk145-toc`
> on branch `yuk-145-toc-slice1`. Authority: the design-approved spec
> `docs/superpowers/specs/2026-05-29-t-oc-ocr-rebuild-design.md` (OC-1..OC-5).
> This lane implements **OC-3 (generalized capture) + OC-5 (evidence-first pad)
> ONLY**. The VLM StructureTask (slice 2) and the TaggingTask + WorkflowJudge +
> "AI auto-enrolled N" review surface (slice 3) are explicitly DEFERRED (see end).

## 1. Problem (spec §4)

`app/api/ingestion/[id]/import/route.ts` hardcodes, for **every** imported block:
- an `attempt` event with `outcome='failure'` (route.ts ~L390-408), and
- a `LearningRecord(kind='mistake')` (route.ts ~L412-433).

i.e. the import model assumes **capture == mistake**. The spec calls this the
highest-leverage model defect: a captured item where the student answered
*correctly* is positive mastery evidence (progress), not a mistake; a captured
item with *no* answer is question/material (item bank), not a mistake.

## 2. Locked decisions consumed

- **OC-3 generalized capture**: outcome is a *signal*, not hardcoded. Unify into
  the generalized `LearningRecord` (mirrors `/api/records` 泛化录入：mistake /
  worked_example / open_question / insight / reflection / observation /
  resource_note).
- **OC-5 evidence-first**: every enrolled item logs an `event` with AI / capture
  provenance (`generated_by`) in payload — traceable + reversible.

## 3. Key schema facts that make this a SMALL change

- `AttemptOnQuestion` (`src/core/schema/event/known.ts` L25-41) **already**
  allows `outcome ∈ {success, failure, partial}`. No event-schema change needed
  for correct / partial captures — we just stop hardcoding `failure`.
- `knowledge_mastery` view (ADR-0012) derives mastery from
  `event WHERE action IN ('attempt','review')`. An `attempt(outcome='success')`
  row therefore feeds mastery **automatically**, with zero new write path.
- FSRS schedule only advances on `action='review'` events
  (`ReviewOnQuestion`). An `attempt` event — success or not — does **NOT** touch
  FSRS state. This gives us the conservative semantics for free (see §6).
- `LearningRecordKind` (`src/core/schema/business.ts` L64-72) already has
  `worked_example` / `open_question` — no enum change needed.

## 4. FSRS-semantics decision (spec §7 open Q2 + the task's "Critical care point")

**Decision: a correct captured answer is INITIAL MASTERY EVIDENCE, NOT a
synthetic FSRS review.** We write `attempt(outcome='success')` (feeds the
`knowledge_mastery` derived view per ADR-0012) and we do **NOT** write a
`review` event, so the FSRS schedule is never advanced from an OCR capture.

Rationale (conservative, lower-risk, documented in the ADR note):
- ADR-0012 mastery is a derived summary over attempt+review events; an attempt
  success is exactly the kind of evidence it already aggregates. Safe.
- FSRS schedule advancement requires a real `ReviewOnQuestion` (it carries
  `fsrs_state_after`, a ts-fsrs Card dump, and a `fsrs_rating`). Synthesising one
  from an OCR capture would fabricate FSRS state with no genuine recall signal —
  high risk, explicitly out of scope. The captured question still becomes
  reviewable in the normal queue (it's a `question` row); its first *real* review
  advances FSRS then.

## 5. Build order (files create-vs-modify)

1. **CREATE** `src/server/ingestion/enroll.ts` — the generalized enrollment
   module. `enrollCapturedBlock(tx, input)` takes one resolved block + an
   `outcome` signal and routes:
   - `outcome='failure'` → `attempt(outcome='failure')` + `LearningRecord(kind='mistake')`
     + returns attribution-followup hint (existing behaviour, byte-for-byte).
   - `outcome='success'` → `attempt(outcome='success')` + `LearningRecord(kind='worked_example')`.
     NO review event (see §4). Provenance event payload carries `generated_by`.
   - `outcome='partial'` → `attempt(outcome='partial')` + `LearningRecord(kind='worked_example')`.
   - `outcome='unanswered'` → NO attempt event; `LearningRecord(kind='open_question')`
     (item bank / to-practice) + a capture provenance event
     (`experimental:record_capture`, subject_kind='record') for OC-5 traceability.
   Returns `{ attemptEventId | null, recordId, needsAttribution }` so the route
   keeps its existing post-commit queueing semantics.
2. **CREATE** `src/server/ingestion/enroll.test.ts` — unit-style routing table
   tests (correct→mastery-evidence / wrong→mistake / partial / no-answer→material),
   plus the "no FSRS review event written for success" assertion.
3. **MODIFY** `app/api/ingestion/[id]/import/route.ts`:
   - add optional `outcome` to `ImportBlock` (`'failure' | 'success' | 'partial'
     | 'unanswered'`, **default `'failure'`** for back-compat — current VisionTab
     UI keeps enrolling mistakes unchanged).
   - relax `final_wrong_answer_md` to allow empty when `outcome='unanswered'`
     (an item-bank capture has no wrong answer). Keep required otherwise.
   - replace the inline event/record writes (route.ts L371-444) with a call to
     `enrollCapturedBlock`.
   - keep all session/status/validation/transaction/figures/structured logic
     untouched. Response shape unchanged (`question_ids` / `mistake_ids` /
     `record_ids`); `mistake_ids` stays the opaque per-block attempt-or-record id
     token (now nullable-backed for unanswered → falls back to record id).
4. **MODIFY** `app/api/ingestion/[id]/import/route.test.ts`: add generalized-outcome
   routing cases; keep ALL existing regression cases green (default outcome=failure).
5. **MODIFY** `docs/adr/0002-...md` + **CREATE** `docs/adr/0024-...md` (see §7).

## 6. Evidence-first provenance (OC-5)

Each enrolled item's event payload carries a `generated_by` provenance marker
(`{ generated_by: 'ingestion_capture', enroll_outcome: <signal> }`). For slice 1
the capture is user-reviewed (the review UI sends the block), so `generated_by`
is `'ingestion_capture'`; slice 3's WorkflowJudge will set
`generated_by:'workflow_judge'` for auto-enrolled high-confidence items and drive
the "AI auto-enrolled N" review surface. The marker is the seam (commented).

## 7. ADR work (spec §10 requires revision/new)

- **MODIFY ADR-0002**: append a revision setting the DIRECTION "VLM owns
  structure; Tencent demoted to text-only OCR hint" (OC-1/OC-2). Slice 1 does NOT
  implement VLM — the revision marks the direction + tencent-demotion as FUTURE
  (slice 2), so the ADR is not stale when slice 2 lands.
- **CREATE ADR-0024**: records the OC-3 generalized-capture model (capture is not
  a mistake; outcome is a signal) + the ADR-0012 positive-signal semantics chosen
  in §4 (mastery evidence, not synthetic FSRS review).

## 8. Conventions / guardrails

- `pnpm audit:schema`: no NEW business columns introduced (we reuse existing
  `learning_record` columns + existing `event` shapes), so no allowlist entry
  needed. Verify with the gate.
- Regression: ingestion `learning_session` / `question_block` / R2 assets / SSE
  progress untouched. Existing import tests must stay green.
- Phase-deferred seams (`generated_by` provenance marker, the deferred slice
  comments) carry explicit comments pointing back at this lane plan.

## 9. Definition of done

`pnpm typecheck`, `pnpm lint`, `pnpm audit:schema`, `pnpm audit:partition`,
`pnpm audit:profile`, `pnpm test`, `DATABASE_URL=postgres://x INTERNAL_TOKEN=x
pnpm build` — all green. Commit on `yuk-145-toc-slice1` with `Refs YUK-145`.

---

## DEFERRED — NOT built in this lane

### Slice 2 — StructureTask (VLM, OC-1/OC-2)
VLM (mimo-v2.5 multimodal)全权拥有结构：跨页大题组装、题图匹配 (replacing the
`assignFigures` heuristic), 布局规范, 可完全覆盖腾讯结构. Tencent demoted to
text-only OCR hint. Absorbs YUK-144 (multi-page). New AI task in
`src/ai/registry.ts` + `src/ai/task-prompts.ts` builder + runner multimodal path
(already exists). The ADR-0002 revision in §7 sets this direction.

### Slice 3 — TaggingTask + WorkflowJudge + review surface (OC-4)
- **TaggingTask**: auto `knowledge_ids` (knowledge_hint + 知识网格 + 题面语义),
  reusing DomainTool grid reads + the knowledge_hint cheap win.
- **WorkflowJudge** (OC-4 confidence gate): high-confidence → auto-enroll (sets
  the `generated_by:'workflow_judge'` provenance this lane stubs), low-confidence
  → review queue (AI-prefilled). Config-flag threshold, conservative start.
- **"AI auto-enrolled N items" review surface** (OC-5): a Living-Note-style panel
  to see + quickly correct what the judge auto-enrolled.
