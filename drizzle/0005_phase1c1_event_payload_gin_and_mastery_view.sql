-- Phase 1c.1 Step 1.3 + 1.5 (Lane A) — hand-written migration.
--
-- Two artefacts that drizzle-kit does not generate on its own:
--   1. GIN index on event.payload using jsonb_path_ops — per ADR-0006 v2 +
--      data-assumptions follow-up (high-frequency payload->>'cause' /
--      'referenced_knowledge_ids' lookups). Must precede knowledge_mastery view
--      because the view's lateral joins rely on payload containment lookups.
--   2. CREATE VIEW knowledge_mastery — per ADR-0012. Replaces the dropped
--      knowledge.{base_mastery, ai_delta_mastery, last_active_at} stub columns
--      with a derived view computed from the event stream.

CREATE INDEX IF NOT EXISTS "event_payload_idx" ON "event" USING GIN ("payload" jsonb_path_ops);
--> statement-breakpoint

CREATE VIEW "knowledge_mastery" AS
WITH attempts AS (
  SELECT
    k.id AS knowledge_id,
    e.id AS event_id,
    e.outcome,
    e.created_at,
    exp(-ln(2) * extract(epoch from (now() - e.created_at)) / (30.0 * 86400.0)) AS weight
  FROM knowledge k
  CROSS JOIN LATERAL (
    SELECT id, outcome, created_at, payload
    FROM event
    WHERE action IN ('attempt', 'review')
      AND subject_kind = 'question'
      AND created_at > now() - interval '180 days'
      AND payload->'referenced_knowledge_ids' @> to_jsonb(k.id)
  ) e
),
agg AS (
  SELECT
    knowledge_id,
    sum(CASE WHEN outcome = 'success' THEN weight ELSE 0 END) AS weighted_success,
    sum(weight) AS weighted_total,
    count(*) AS evidence_count,
    max(created_at) AS last_evidence_at
  FROM attempts
  GROUP BY knowledge_id
),
activity AS (
  SELECT
    k.id AS knowledge_id,
    max(e.created_at) AS last_event_at
  FROM knowledge k
  CROSS JOIN LATERAL (
    SELECT created_at
    FROM event
    WHERE (subject_kind = 'knowledge' AND subject_id = k.id)
       OR (payload->'referenced_knowledge_ids' @> to_jsonb(k.id))
       OR (payload->'knowledge_ids' @> to_jsonb(k.id))
  ) e
  GROUP BY k.id
)
SELECT
  k.id AS knowledge_id,
  CASE
    WHEN agg.evidence_count IS NULL OR agg.evidence_count = 0 THEN NULL
    WHEN agg.evidence_count < 3 THEN 0.5::real
    ELSE (agg.weighted_success / NULLIF(agg.weighted_total, 0))::real
  END AS mastery,
  coalesce(agg.evidence_count, 0)::integer AS evidence_count,
  agg.last_evidence_at,
  coalesce(activity.last_event_at, k.created_at) AS last_active_at
FROM knowledge k
LEFT JOIN agg ON agg.knowledge_id = k.id
LEFT JOIN activity ON activity.knowledge_id = k.id;
