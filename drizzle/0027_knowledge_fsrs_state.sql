-- YUK-203 P3:
-- FSRS scheduling is now keyed by knowledge point when a question carries
-- knowledge labels. Backfill existing question-level projection rows into one
-- row per knowledge id, choosing the most-overdue source state for each node.
WITH question_knowledge_fsrs AS (
  SELECT
    link.knowledge_id,
    m.state,
    m.due_at,
    m.last_review_event_id,
    m.updated_at,
    q.created_at AS question_created_at,
    q.id AS question_id
  FROM "material_fsrs_state" m
  INNER JOIN "question" q ON q.id = m.subject_id
  CROSS JOIN LATERAL jsonb_array_elements_text(q.knowledge_ids) AS link(knowledge_id)
  WHERE m.subject_kind = 'question'
),
chosen AS (
  SELECT DISTINCT ON (knowledge_id)
    knowledge_id,
    state,
    due_at,
    last_review_event_id
  FROM question_knowledge_fsrs
  ORDER BY
    knowledge_id,
    due_at ASC,
    updated_at DESC,
    question_created_at ASC,
    question_id ASC
)
INSERT INTO "material_fsrs_state" (
  "id",
  "subject_kind",
  "subject_id",
  "state",
  "due_at",
  "last_review_event_id",
  "updated_at"
)
SELECT
  'fsrs_knowledge_' || md5(knowledge_id),
  'knowledge',
  knowledge_id,
  state,
  due_at,
  last_review_event_id,
  now()
FROM chosen
ON CONFLICT ("subject_kind", "subject_id") DO NOTHING;
--> statement-breakpoint
-- Retire migrated question-level cards. Unlabeled legacy questions keep their
-- question rows and remain schedulable through the compatibility fallback.
DELETE FROM "material_fsrs_state" m
USING "question" q
WHERE m.subject_kind = 'question'
  AND q.id = m.subject_id
  AND jsonb_array_length(q.knowledge_ids) > 0;
