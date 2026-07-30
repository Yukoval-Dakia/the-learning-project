-- YUK-827 P0 cutover: retire every conjecture proposal that is still pending
-- before the response-aware probe producer starts.
--
-- This migration ships in the same image that first produces probe_quality v3
-- with probe-spec schema v2. The migrate init container completes before app and
-- worker startup, so every proposal visible here predates the response-signature
-- runtime. Retiring the complete pending set avoids stranding an old proposal
-- behind the new fail-closed accept gate.
--
-- Keep the correction agent-authored and already ingested. This is artifact
-- retirement, not an owner rejection or learner-memory signal.
INSERT INTO "event" (
  "id",
  "actor_kind",
  "actor_ref",
  "action",
  "subject_kind",
  "subject_id",
  "outcome",
  "payload",
  "caused_by_event_id",
  "affected_scopes",
  "ingest_at",
  "created_at"
)
SELECT
  'yuk827_response_signature_retract_' || md5(proposal."id"),
  'agent',
  'yuk827_response_signature_migration',
  'correct',
  'event',
  proposal."id",
  'success',
  jsonb_build_object(
    'correction_kind', 'retract',
    'reason_md', 'Conjecture retired at the YUK-827 response-signature cutover; regenerate under probe-spec v2.',
    'affected_refs', jsonb_build_array(
      jsonb_build_object('kind', 'open_inquiry', 'id', proposal."id")
    )
  ),
  proposal."id",
  ARRAY[]::text[],
  GREATEST(now(), proposal."created_at" + interval '1 microsecond'),
  GREATEST(now(), proposal."created_at" + interval '1 microsecond')
FROM "event" AS proposal
WHERE proposal."action" = 'experimental:proposal'
  AND proposal."subject_kind" = 'mind_model'
  AND proposal."payload" #>> '{ai_proposal,kind}' = 'conjecture'
  AND NOT COALESCE((
    SELECT (
      jsonb_typeof(decision."payload" -> 'rating') = 'string'
      AND decision."payload" ->> 'rating' IN (
        'accept',
        'reverse',
        'change_type',
        'dismiss',
        'rollback'
      )
    )
    FROM "event" AS decision
    WHERE decision."caused_by_event_id" = proposal."id"
      AND decision."action" = 'rate'
    ORDER BY decision."created_at" DESC, decision."id" DESC
    LIMIT 1
  ), false)
  AND NOT COALESCE((
    jsonb_typeof(proposal."payload" -> 'rubric_verdict') = 'object'
    AND proposal."payload" #> '{rubric_verdict,ok}' = 'false'::jsonb
  ), false)
  AND NOT COALESCE((
    jsonb_typeof(proposal."payload" -> 'topology_verdict') = 'object'
    AND proposal."payload" #>> '{topology_verdict,status}' = 'reject'
  ), false)
ON CONFLICT ("id") DO NOTHING;
