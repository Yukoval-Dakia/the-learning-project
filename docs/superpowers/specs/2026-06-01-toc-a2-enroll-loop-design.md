# T-OC A2/A3 — close the ingestion enroll loop (YUK-164)

> **Status**: design, 2026-06-01. Scopes YUK-164 slice 3b after Slice B (YUK-190, observe wiring) + A1 (YUK-145, `MistakeEnrollTask` observe-draft) already shipped.
> **Decisions** (user, 2026-06-01): D1=**C** (full 4-state block machine), D2=**A** (revert = retract event + archive record + reset block, keep question), D3=**A** (OC-5 = new `/record` tab), D4=stay manual opt-in (no code default flip), D5=event-marker-only first.

## 1. Block-status state machine (D1=C)

`QuestionBlockStatus` grows from `['draft','imported','ignored']` to add **`auto_enrolled`** — a terminal-but-revertible state distinct from human `imported`. Transitions:

```
draft ──(human import)──────────→ imported   (terminal)
draft ──(human dismiss)─────────→ ignored    (terminal)
draft ──(WorkflowJudge auto, flag ON)→ auto_enrolled   (terminal, revertible)
auto_enrolled ──(OC-5 revert)───→ draft      (back to human review)
```

- `auto_enrolled` ≠ `imported`: provenance is `generated_by='workflow_judge'`; the OC-5 surface lists these; revert is allowed only from `auto_enrolled`.
- `question_block.status` is a free-form `text` column → no DB enum migration; the machine is enforced in code (the Zod enum + the write sites).

## 2. Session-lifecycle coherence

Session machine unchanged (`uploaded→queued→extracting→extracted|partial|failed`; `extracted/partial→reviewed→imported`). Auto-enroll stays **`extracted`-only** for enroll mode (already guarded, `auto-enroll.ts:156`) and does NOT change session status (keeps its "doesn't close the session" contract). Coherence rules:

- **Manual import skips non-`draft` blocks.** The import route imports only `status='draft'` blocks; `auto_enrolled`/`imported`/`ignored` are skipped (idempotent — a flag-ON `extracted` session is still human-importable for its remaining `draft` blocks).
- **`commitImport` stays the terminal owner** (allowed from `extracted`/`reviewed`, unchanged). A mixed session (some `auto_enrolled`, some `draft`) reaches `imported` when the human commits — even with zero remaining `draft` blocks (import nothing, flip terminal).

## 3. A2 — answered-mistake enrollment

In **enroll** mode, for a `route==='auto'` block WITH a captured answer (`wrong_answer_md` non-empty), compute the `MistakeEnrollTask` draft (the same producer A1 runs in observe) and enroll the real outcome:

- `outcome = draft.wrong_answer` (`failure|partial|success|unanswered`, 1:1 with `EnrollOutcome`); falls back to `'unanswered'` when there's no answer or the draft errors.
- `answerMd = block.wrong_answer_md`; `enrollCapturedBlock` already routes all 4 outcomes (no change there) — failure→attempt+mistake, success/partial→attempt+worked_example, unanswered→open_question.
- block → `auto_enrolled` (not `imported`).
- **cause**: for a `failure` with `draft.cause`, write the drafted cause directly as a chained `judge` event (mirroring `attribute.ts:106-128`: `action='judge'`, `subject_kind='event'`, `subject_id=caused_by=attemptEventId`, `payload.cause={primary_category,secondary_categories,analysis_md,confidence}`, `actor_ref='workflow_judge'`). The draft's cause shape == `AttributionOutput` == `CauseSchema`, so no re-run of `AttributionTask` (the draft already paid that cost) and no second cause-writer — `writeEvent` stays the single owner (ADR-0005).

The draft is computed **once** per answered-auto block and shared: observe mode attaches it to the audit event (A1), enroll mode enrolls from it (A2).

## 4. Revert primitive (B1b, D2=A)

`revertAutoEnrolledBlock(tx, blockId)` in one transaction:
- assert the block is `status='auto_enrolled'` (else 404/409);
- write one `CorrectEvent(correction_kind='retract')` against the attempt/capture event (append-only audit; the retract IS the record);
- archive the `learning_record` (set `archived_at` / archived_reason);
- reset `question_block` → `status='draft'`, NULL `imported_question_id`/`imported_attempt_event_id`;
- leave the `question` row in place (harmless item-bank content, reusable; matches `retractAiProposal`'s "set dormant, never hard-delete, keep evidence chain").

## 5. Slices

- **B1a** (this PR): enum `auto_enrolled`; enroll-branch draft→outcome+answer+cause + `auto_enrolled` status; manual-import skip non-`draft`. Backend, behind the OFF flag, unit+DB tested.
- **B1b**: `revertAutoEnrolledBlock` + route. Backend.
- **B2** (pre-flight-gated): OC-5 `/record` tab — list `action='experimental:auto_enroll_observed'` + enroll markers, revert.
- **B3** (pre-flight-gated): review-UI prefill display (event-marker-only per D5).
- **B4**: flag opt-in doc/guard + TaggingTask server-path-only doc-note.

Flag (`WORKFLOW_JUDGE_AUTO_ENROLL_ENABLED`) stays a deliberate manual opt-in (D4); no code flips the default. B1a makes the enroll path *correct + safe to flip later*; it does not flip it.

## 6. Audit query correction

The canonical OC-5/observe audit query is `event WHERE action='experimental:auto_enroll_observed'` (or `payload->>'mode'`), NOT `generated_by='workflow_judge'` alone — because once the flag flips, real enroll events also carry `generated_by='workflow_judge'`. (Supersedes the lane-plan's `generated_by` query.)
