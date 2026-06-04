# ADR-0028 — FSRS scheduling by knowledge point, with question probes

**Status**: Accepted (2026-06-03)
**Supersedes**: the question-only scheduling assumption in Phase 1c.1 comments and review-read paths.
**Part of**: YUK-203（领域模型重构）·P3。**Decision source**: `docs/design/2026-06-03-target-domain-model.md` §5/§7.1。

---

## 背景

`material_fsrs_state` was originally populated as one card per question:
`(subject_kind='question', subject_id=question.id)`. That made the first review
loop straightforward, but it does not match the target model for generated
variants and application questions:

- multiple variants can probe the same knowledge point;
- repeating the same application question trains answer memory instead of the
skill;
- `knowledge_mastery` already derives mastery at the knowledge-node level.

The schema already had the generic `(subject_kind, subject_id)` key. YUK-203 P3
uses that generic point for the real scheduling unit.

## 决定

1. For questions with `knowledge_ids`, FSRS projection rows are keyed by
   `(subject_kind='knowledge', subject_id=<knowledge_id>)`.
2. The review event remains question-scoped:
   `event(action='review', subject_kind='question', subject_id=<question_id>)`.
   The user answers a concrete question; the scheduling projection updated by
   that answer is recorded in `payload.fsrs_subject_kind`,
   `payload.fsrs_subject_ids`, and `payload.fsrs_state_after_by_subject`.
3. `/api/review/due` reads due knowledge rows first, then selects a concrete
   non-draft question linked to that knowledge point. The deterministic seam
   rotates away from the last reviewed question when another linked question is
   available. A later AI scheduler can replace only this selection seam.
4. `quiz_verify` enrolls verified generated questions by knowledge id. Unlabeled
   legacy questions still fall back to question-level FSRS so they are not
   silently dropped.
5. Existing question-level rows with knowledge labels are forward-migrated into
   knowledge rows, choosing the most-overdue source state per knowledge id, then
   the migrated question rows are deleted. Unlabeled question rows remain.

## 后果

**正面**
- FSRS cadence aligns with the knowledge spine and `knowledge_mastery`.
- Generated variants no longer create independent memory cards for the same
  skill.
- Review scheduling can swap question probes without changing the persisted
  memory unit.

**代价 / 风险**
- A single review can update multiple FSRS rows when a question has multiple
  knowledge labels. The submit route therefore takes transaction-scoped advisory
  locks per FSRS subject before reading, scheduling, and upserting.
- Read paths that joined `material_fsrs_state(subject_kind='question')` to
  `question` must be updated or kept explicitly as legacy compatibility.
- The deterministic probe picker is intentionally simple; AI selection remains a
  future replacement at the same seam.

## 关联

- Design: `docs/design/2026-06-03-target-domain-model.md`
- Migration: `drizzle/0027_knowledge_fsrs_state.sql`
- Code: `app/api/review/submit/route.ts`, `src/server/review/due-list.ts`,
  `src/server/boss/handlers/quiz_verify.ts`
