-- YUK-821 P0 cutover: retire every conjecture proposal that is still pending
-- before the audit-bound v2 producer can start.
--
-- This migration ships in the same image that first produces probe_quality v2.
-- Production starts the one-shot migrate container before app and worker
-- (docker-compose.yml depends_on migrate: service_completed_successfully), so a
-- proposal visible to this statement cannot have been produced by the new v2
-- runtime. Trying to recognize a "valid enough" packet here would duplicate the
-- Zod contract in SQL and inevitably leave malformed rows stranded behind a 409.
-- The safe cutover is therefore to retire the complete pre-binding pending set;
-- after migrate succeeds, runtime Zod is the single authoritative v2 gate.
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
  'yuk821_audit_bind_retract_' || md5(proposal."id"),
  'agent',
  'yuk821_audit_binding_migration',
  'correct',
  'event',
  proposal."id",
  'success',
  jsonb_build_object(
    'correction_kind', 'retract',
    'reason_md', 'Conjecture retired at the YUK-821 audit-binding cutover; regenerate under v2.',
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
  -- Decided rows retain their historical meaning.
  AND NOT EXISTS (
    SELECT 1
    FROM "event" AS decision
    WHERE decision."caused_by_event_id" = proposal."id"
      AND decision."action" = 'rate'
  )
  -- Do not reproduce CorrectEvent parsing in SQL. An existing valid retraction
  -- may receive this deterministic cutover retraction again; that is harmless
  -- and safer than trusting a malformed raw correction that runtime ignores.
  AND NOT COALESCE((
    jsonb_typeof(proposal."payload" -> 'rubric_verdict') = 'object'
    AND proposal."payload" #>> '{rubric_verdict,ok}' = 'false'
  ), false)
  AND NOT COALESCE((
    jsonb_typeof(proposal."payload" -> 'topology_verdict') = 'object'
    AND proposal."payload" #>> '{topology_verdict,status}' = 'reject'
  ), false)
ON CONFLICT ("id") DO NOTHING;
