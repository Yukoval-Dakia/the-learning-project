-- YUK-308 — data-only backfill (no DDL / no schema-model change → NO meta
-- snapshot, mirrors the 0059/0060/0061/0062 precedent). Idempotent: the
-- `metadata -> 'dismissed_at' IS NULL` guard makes re-runs no-ops.
--
-- Before dismissQuestionDraftProposal existed (this PR), dismissing a
-- question_draft proposal ran the generic rate-only path: the rate(dismiss)
-- event committed but the draft question row kept NO metadata.dismissed_at
-- tombstone, so every historically rejected draft kept surfacing in
-- query_questions / listQuestions(include_drafts) / draft review / write_quiz's
-- draft admission. dismissAiProposal early-returns on non-pending proposals,
-- so the new applier can never repair those rows — this one-time pass stamps
-- the same tombstone the applier now writes (seconds-epoch dismissed_at +
-- reason + the deciding proposal id) on every still-draft question whose
-- question_draft proposal carries a dismiss rate event.
--
-- Rows already promoted to draft_status='active' are deliberately left alone:
-- their accept decision won, and tombstoning a pooled question would wrongly
-- hide it from every draft-aware reader.
UPDATE "question" AS q
SET
  "metadata" = COALESCE(q."metadata", '{}'::jsonb) || jsonb_build_object(
    'dismissed_at', d.dismissed_at,
    'dismissed_reason', 'question_draft_dismissed',
    'dismissed_proposal_id', d.proposal_id
  ),
  "updated_at" = now()
FROM (
  SELECT DISTINCT ON (p.subject_id)
    p.subject_id AS question_id,
    p.id AS proposal_id,
    floor(extract(epoch FROM r.created_at))::bigint AS dismissed_at
  FROM "event" AS r
  JOIN "event" AS p ON p.id = r.caused_by_event_id
  WHERE r.action = 'rate'
    AND r.payload ->> 'rating' = 'dismiss'
    AND p.payload -> 'ai_proposal' ->> 'kind' = 'question_draft'
    AND p.subject_kind = 'question'
  ORDER BY p.subject_id, r.created_at
) AS d
WHERE q.id = d.question_id
  AND q.draft_status = 'draft'
  AND (q.metadata -> 'dismissed_at') IS NULL;
