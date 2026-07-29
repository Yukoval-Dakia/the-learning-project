-- YUK-821: retire pre-v3 conjecture proposals that can no longer be accepted safely.
--
-- The v3 accept path requires a frozen DiagnosticSpec, a primary/follow-up probe
-- pair, and a passing independent-review audit. Historical v1/v2 proposals do not
-- contain that packet. Leaving them pending would strand a visible Teaching Brief:
-- every accept would deterministically return CONJECTURE_PROBE_QUALITY_REQUIRED,
-- while the old proposal would continue occupying its pending dedup key.
--
-- Retire those rows with an AGENT-AUTHORED correction, not rate(dismiss):
-- rate(dismiss) is an owner preference signal and would corrupt acceptance
-- calibration. A correction(retract) accurately says the legacy artifact is no
-- longer actionable without pretending that the owner rejected its claim.
--
-- The event id is deterministic and the anti-join makes this safe to replay.
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
  "created_at"
)
SELECT
  'yuk821_legacy_retract_' || md5(proposal."id"),
  'agent',
  'yuk821_legacy_migration',
  'correct',
  'event',
  proposal."id",
  'success',
  jsonb_build_object(
    'correction_kind', 'retract',
    'reason_md', 'Legacy conjecture retired: no YUK-821 verified diagnostic/probe package.',
    'affected_refs', jsonb_build_array(
      jsonb_build_object('kind', 'open_inquiry', 'id', proposal."id")
    )
  ),
  proposal."id",
  proposal."affected_scopes",
  GREATEST(now(), proposal."created_at" + interval '1 microsecond')
FROM "event" AS proposal
WHERE proposal."action" = 'experimental:proposal'
  AND proposal."subject_kind" = 'mind_model'
  AND proposal."payload" #>> '{ai_proposal,kind}' = 'conjecture'
  -- A clearly complete v3 packet stays actionable. Runtime Zod + structural
  -- validation remains the authoritative accept gate for every field.
  AND NOT COALESCE((
    jsonb_typeof(proposal."payload" #> '{ai_proposal,proposed_change,diagnostic_spec}') = 'object'
    AND jsonb_typeof(proposal."payload" #> '{ai_proposal,proposed_change,probe_spec}') = 'object'
    AND jsonb_typeof(proposal."payload" #> '{ai_proposal,proposed_change,followup_probe_spec}') = 'object'
    AND jsonb_typeof(proposal."payload" #> '{ai_proposal,proposed_change,probe_quality}') = 'object'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,probe_quality,schema_version}' = '1'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,probe_quality,passed}' = 'true'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,probe_quality,final_review,verdict}' = 'pass'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,discriminating}' = 'true'
    AND jsonb_typeof(proposal."payload" #> '{ai_proposal,proposed_change,predicted_p}') = 'number'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,probe_md}'
      = proposal."payload" #>> '{ai_proposal,proposed_change,probe_spec,prompt_md}'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,probe_reference_md}'
      = proposal."payload" #>> '{ai_proposal,proposed_change,probe_spec,reference_md}'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,followup_probe_md}'
      = proposal."payload" #>> '{ai_proposal,proposed_change,followup_probe_spec,prompt_md}'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,followup_probe_reference_md}'
      = proposal."payload" #>> '{ai_proposal,proposed_change,followup_probe_spec,reference_md}'
  ), false)
  -- Only truly pending rows are retired. A rate means the proposal was already
  -- decided. For corrections, the latest semantic event wins: no correction or
  -- a latest restore is active/pending; retract/mark_wrong/supersede is terminal.
  AND NOT EXISTS (
    SELECT 1
    FROM "event" AS decision
    WHERE decision."caused_by_event_id" = proposal."id"
      AND decision."action" = 'rate'
  )
  AND COALESCE(
    (
      SELECT correction."payload" ->> 'correction_kind'
      FROM "event" AS correction
      WHERE correction."action" = 'correct'
        AND correction."subject_kind" = 'event'
        AND correction."subject_id" = proposal."id"
      ORDER BY correction."created_at" DESC, correction."id" DESC
      LIMIT 1
    ),
    'restore'
  ) = 'restore'
  AND NOT COALESCE((
    jsonb_typeof(proposal."payload" -> 'rubric_verdict') = 'object'
    AND proposal."payload" #>> '{rubric_verdict,ok}' = 'false'
  ), false)
  AND NOT COALESCE((
    jsonb_typeof(proposal."payload" -> 'topology_verdict') = 'object'
    AND proposal."payload" #>> '{topology_verdict,status}' = 'reject'
  ), false)
ON CONFLICT ("id") DO NOTHING;
