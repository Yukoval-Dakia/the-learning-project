ALTER TABLE "intervention"
  ADD COLUMN "settlement_json" jsonb;

-- Existing YUK-791 active rows predate settlement materialization. Preserve
-- their original activation clock and let intervention_prepare_recovery
-- idempotently create the three question/FSRS rows for eligible rows after
-- deploy. Shadow rows keep only this audit ledger and remain invisible.
UPDATE "intervention"
SET "settlement_json" = jsonb_build_object(
  'schema_version', 1,
  'diagnostics', jsonb_build_object(
    'immediate', jsonb_build_object(
      'kind', 'immediate',
      'question_id', 'intervention:' || "id" || ':v' || "version"::text || ':immediate',
      'due_at', to_char(
        "activated_at" AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'status', 'scheduled',
      'review_event_id', NULL,
      'verdict_event_id', NULL,
      'completed_at', NULL
    ),
    'delayed', jsonb_build_object(
      'kind', 'delayed',
      'question_id', 'intervention:' || "id" || ':v' || "version"::text || ':delayed',
      'due_at', to_char(
        ("activated_at" + interval '7 days') AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'status', 'scheduled',
      'review_event_id', NULL,
      'verdict_event_id', NULL,
      'completed_at', NULL
    ),
    'transfer', jsonb_build_object(
      'kind', 'transfer',
      'question_id', 'intervention:' || "id" || ':v' || "version"::text || ':transfer',
      'due_at', to_char(
        ("activated_at" + interval '21 days') AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'status', 'scheduled',
      'review_event_id', NULL,
      'verdict_event_id', NULL,
      'completed_at', NULL
    )
  ),
  'scheduled_at', to_char(
    "activated_at" AT TIME ZONE 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  ),
  'completed_at', NULL
)
WHERE "status" = 'active'
  AND "settlement_json" IS NULL
  AND "activated_at" IS NOT NULL;

ALTER TABLE "intervention"
  DROP CONSTRAINT "intervention_active_shape_ck";

ALTER TABLE "intervention"
  ADD CONSTRAINT "intervention_active_shape_ck" CHECK (
    "status" <> 'active' OR (
      "recommendation_json" IS NOT NULL
      AND "recommendation_json" ->> 'kind' = 'recommendation'
      AND "package_json" IS NOT NULL
      AND jsonb_typeof("package_json") = 'object'
      AND "settlement_json" IS NOT NULL
      AND jsonb_typeof("settlement_json") = 'object'
      AND "failure_code" IS NULL
      AND "activated_at" IS NOT NULL
    )
  );

ALTER TABLE "intervention"
  ADD CONSTRAINT "intervention_settled_shape_ck" CHECK (
    "status" <> 'settled' OR (
      "outcome" IS NOT NULL
      AND "settlement_json" IS NOT NULL
      AND "settlement_json" ->> 'completed_at' IS NOT NULL
    )
  );
