-- YUK-821 P0 closeout: retire still-pending conjectures whose passing review is
-- not bound to the exact frozen hypothesis + persisted probe package or lacks
-- durable task-run lineage.
--
-- 0082 retired incomplete pre-v3 packets, but its v1 audit predicate could not
-- prove which hypothesis/package the reviewer actually saw. A v2 audit carries
-- immutable reviewed_hypothesis + reviewed_package snapshots and requires author +
-- reviewer task-run ids on the passing attempt. New accepts fail closed on the same
-- contract.
--
-- Keep the upgrade correction agent-authored and already ingested. It is artifact
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
    'reason_md', 'Conjecture retired: probe-quality review is not bound to its persisted package.',
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
    jsonb_typeof(proposal."payload" #> '{ai_proposal,proposed_change,diagnostic_spec}') = 'object'
    AND jsonb_typeof(proposal."payload" #> '{ai_proposal,proposed_change,probe_spec}') = 'object'
    AND jsonb_typeof(proposal."payload" #> '{ai_proposal,proposed_change,followup_probe_spec}') = 'object'
    AND jsonb_typeof(proposal."payload" #> '{ai_proposal,proposed_change,probe_quality}') = 'object'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,probe_quality,schema_version}' = '2'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,probe_quality,passed}' = 'true'
    AND jsonb_typeof(
      proposal."payload" #> '{ai_proposal,proposed_change,probe_quality,final_review}'
    ) = 'object'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,probe_quality,final_review,verdict}' = 'pass'
    AND CASE
      WHEN jsonb_typeof(
        proposal."payload" #> '{ai_proposal,proposed_change,probe_quality,final_review,failure_codes}'
      ) = 'array'
        THEN jsonb_array_length(
          proposal."payload" #> '{ai_proposal,proposed_change,probe_quality,final_review,failure_codes}'
        ) = 0
      ELSE false
    END
    AND char_length(
      btrim(
        proposal."payload" #>> '{ai_proposal,proposed_change,probe_quality,final_review,explanation_md}'
      )
    ) BETWEEN 1 AND 1000
    AND proposal."payload" #>> '{ai_proposal,proposed_change,discriminating}' = 'true'
    AND jsonb_typeof(proposal."payload" #> '{ai_proposal,proposed_change,predicted_p}') = 'number'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,probe_quality,reviewed_hypothesis,kind}'
      = 'proposal'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,probe_quality,reviewed_hypothesis,claim_md}'
      = proposal."payload" #>> '{ai_proposal,proposed_change,claim_md}'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,probe_quality,reviewed_hypothesis,knowledge_id}'
      = proposal."payload" #>> '{ai_proposal,proposed_change,knowledge_id}'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,probe_quality,reviewed_hypothesis,cause_category}'
      = proposal."payload" #>> '{ai_proposal,proposed_change,cause_category}'
    AND proposal."payload" #> '{ai_proposal,proposed_change,probe_quality,reviewed_hypothesis,recurrence_count}'
      = proposal."payload" #> '{ai_proposal,proposed_change,recurrence_count}'
    AND proposal."payload" #> '{ai_proposal,proposed_change,probe_quality,reviewed_hypothesis,diagnostic_spec}'
      = proposal."payload" #> '{ai_proposal,proposed_change,diagnostic_spec}'
    -- Ordering invariant: reviewed_hypothesis.evidence_event_ids and
    -- evidence_refs[kind=event].id both preserve the first-seen order from the
    -- same deduplicated draft.evidence_event_ids array.
    AND proposal."payload" #> '{ai_proposal,proposed_change,probe_quality,reviewed_hypothesis,evidence_event_ids}'
      = COALESCE(
        CASE
          WHEN jsonb_typeof(proposal."payload" #> '{ai_proposal,evidence_refs}') = 'array'
            THEN (
              SELECT jsonb_agg(evidence.ref -> 'id' ORDER BY evidence.ordinality)
              FROM jsonb_array_elements(proposal."payload" #> '{ai_proposal,evidence_refs}')
                WITH ORDINALITY AS evidence(ref, ordinality)
              WHERE evidence.ref ->> 'kind' = 'event'
            )
          ELSE '[]'::jsonb
        END,
        '[]'::jsonb
      )
    AND proposal."payload" #>> '{ai_proposal,proposed_change,probe_md}'
      = proposal."payload" #>> '{ai_proposal,proposed_change,probe_spec,prompt_md}'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,probe_reference_md}'
      = proposal."payload" #>> '{ai_proposal,proposed_change,probe_spec,reference_md}'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,followup_probe_md}'
      = proposal."payload" #>> '{ai_proposal,proposed_change,followup_probe_spec,prompt_md}'
    AND proposal."payload" #>> '{ai_proposal,proposed_change,followup_probe_reference_md}'
      = proposal."payload" #>> '{ai_proposal,proposed_change,followup_probe_spec,reference_md}'
    AND proposal."payload" #> '{ai_proposal,proposed_change,probe_quality,reviewed_package,primary}'
      = proposal."payload" #> '{ai_proposal,proposed_change,probe_spec}'
    AND proposal."payload" #> '{ai_proposal,proposed_change,probe_quality,reviewed_package,followup}'
      = proposal."payload" #> '{ai_proposal,proposed_change,followup_probe_spec}'
    AND proposal."payload" #> '{ai_proposal,proposed_change,probe_quality,reviewed_package,predicted_p}'
      = proposal."payload" #> '{ai_proposal,proposed_change,predicted_p}'
    AND jsonb_path_exists(
      proposal."payload",
      '$.ai_proposal.proposed_change.probe_quality.attempts[last] ? (
        @.outcome == "passed"
        && @.author_task_run_id.type() == "string"
        && @.author_task_run_id != ""
        && @.reviewer_task_run_id.type() == "string"
        && @.reviewer_task_run_id != ""
      )'
    )
  ), false)
  -- Only active pending rows are retired. Decided or already-terminal rows keep
  -- their historical meaning and stay readable through the v1 schema.
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
