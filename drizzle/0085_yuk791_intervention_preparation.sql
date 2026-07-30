-- YUK-791 — versioned, fail-closed intervention preparation aggregate.
--
-- Every row freezes one immutable snapshot and preserves the recommendation,
-- authored package attempts, review provenance, terminal failure, and delivery
-- mode. Agency is the single writer; Practice never updates this table.
CREATE TABLE "intervention" (
  "id" text NOT NULL,
  "version" integer NOT NULL,
  "revision" integer DEFAULT 0 NOT NULL,
  "source_probe_result_event_id" text NOT NULL,
  "conjecture_event_id" text NOT NULL,
  "status" text DEFAULT 'preparing' NOT NULL,
  "delivery_mode" text DEFAULT 'shadow' NOT NULL,
  "outcome" text,
  "idempotency_key" text NOT NULL,
  "preparation_job_id" text,
  "snapshot_json" jsonb NOT NULL,
  "recommendation_json" jsonb,
  "package_json" jsonb,
  "preparation_attempts_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "failure_code" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "activated_at" timestamp with time zone,
  CONSTRAINT "intervention_id_version_pk" PRIMARY KEY ("id", "version"),
  CONSTRAINT "intervention_source_probe_result_event_fk"
    FOREIGN KEY ("source_probe_result_event_id") REFERENCES "event"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "intervention_conjecture_event_fk"
    FOREIGN KEY ("conjecture_event_id") REFERENCES "event"("id") ON DELETE NO ACTION ON UPDATE NO ACTION,
  CONSTRAINT "intervention_version_positive_ck" CHECK ("version" > 0),
  CONSTRAINT "intervention_revision_nonnegative_ck" CHECK ("revision" >= 0),
  CONSTRAINT "intervention_status_ck" CHECK (
    "status" IN (
      'preparing',
      'preparation_failed',
      'active',
      'needs_revision',
      'settled',
      'canceled'
    )
  ),
  CONSTRAINT "intervention_delivery_mode_ck" CHECK (
    "delivery_mode" IN ('shadow', 'eligible')
  ),
  CONSTRAINT "intervention_outcome_ck" CHECK (
    "outcome" IS NULL OR "outcome" IN ('effective', 'ineffective', 'inconclusive')
  ),
  CONSTRAINT "intervention_attempts_array_ck" CHECK (
    jsonb_typeof("preparation_attempts_json") = 'array'
  ),
  CONSTRAINT "intervention_active_shape_ck" CHECK (
    "status" <> 'active' OR (
      "recommendation_json" IS NOT NULL
      AND "recommendation_json" ->> 'kind' = 'recommendation'
      AND "package_json" IS NOT NULL
      AND jsonb_typeof("package_json") = 'object'
      AND "failure_code" IS NULL
      AND "activated_at" IS NOT NULL
    )
  ),
  CONSTRAINT "intervention_failed_shape_ck" CHECK (
    "status" <> 'preparation_failed' OR (
      "failure_code" IS NOT NULL
      AND "activated_at" IS NULL
    )
  )
);

CREATE UNIQUE INDEX "intervention_source_version_uq"
  ON "intervention" ("source_probe_result_event_id", "version");
CREATE UNIQUE INDEX "intervention_idempotency_key_uq"
  ON "intervention" ("idempotency_key");
CREATE UNIQUE INDEX "intervention_one_preparing_version_uq"
  ON "intervention" ("id")
  WHERE "status" = 'preparing';
CREATE INDEX "intervention_status_updated_idx"
  ON "intervention" ("status", "updated_at" DESC);
CREATE INDEX "intervention_conjecture_idx"
  ON "intervention" ("conjecture_event_id", "version" DESC);
