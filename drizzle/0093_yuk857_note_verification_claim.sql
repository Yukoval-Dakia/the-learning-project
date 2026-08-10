CREATE TABLE "note_verification_claim" (
  "artifact_id" text PRIMARY KEY NOT NULL REFERENCES "artifact"("id") ON DELETE CASCADE,
  "artifact_version" integer NOT NULL,
  "state" text NOT NULL,
  "fence" integer DEFAULT 0 NOT NULL,
  "claim_token" uuid,
  "task_run_id" text,
  "result_json" jsonb,
  "result_attempts" integer DEFAULT 0 NOT NULL,
  "provider_attempts" integer DEFAULT 0 NOT NULL,
  "error_message" text,
  "available_at" timestamp with time zone NOT NULL,
  "lease_expires_at" timestamp with time zone,
  "claimed_at" timestamp with time zone,
  "provider_started_at" timestamp with time zone,
  "result_ready_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "created_at" timestamp with time zone NOT NULL,
  "updated_at" timestamp with time zone NOT NULL,
  CONSTRAINT "note_verification_claim_state_ck" CHECK ("state" IN ('retry_wait','reserved','provider_started','attempts_exhausted','ambiguous','result_ready','completed')),
  CONSTRAINT "note_verification_claim_fence_ck" CHECK ("fence" >= 0),
  CONSTRAINT "note_verification_claim_shape_ck" CHECK (
    ("state" = 'retry_wait' AND "claim_token" IS NULL AND "lease_expires_at" IS NULL AND "provider_started_at" IS NULL)
    OR ("state" = 'reserved' AND "claim_token" IS NOT NULL AND "task_run_id" IS NOT NULL AND "lease_expires_at" IS NOT NULL AND "provider_started_at" IS NULL AND "result_json" IS NULL)
    OR ("state" = 'provider_started' AND "claim_token" IS NOT NULL AND "task_run_id" IS NOT NULL AND "provider_started_at" IS NOT NULL AND "result_json" IS NULL)
    OR ("state" = 'attempts_exhausted' AND "claim_token" IS NULL AND "task_run_id" IS NULL AND "lease_expires_at" IS NULL AND "provider_started_at" IS NULL AND "result_json" IS NULL AND "error_message" IS NOT NULL)
    OR ("state" = 'ambiguous' AND ("provider_started_at" IS NOT NULL OR "result_json" IS NOT NULL))
    OR ("state" = 'result_ready' AND "result_json" IS NOT NULL AND "lease_expires_at" IS NULL)
    OR ("state" = 'completed' AND "result_json" IS NOT NULL AND "completed_at" IS NOT NULL AND "claim_token" IS NULL AND "lease_expires_at" IS NULL)
  ),
  CONSTRAINT "note_verification_claim_result_attempts_ck" CHECK ("result_attempts" >= 0),
  CONSTRAINT "note_verification_claim_provider_attempts_ck" CHECK ("provider_attempts" >= 0 AND "provider_attempts" <= 3)
);
--> statement-breakpoint
CREATE INDEX "note_verification_claim_recovery_idx"
  ON "note_verification_claim" ("state", "available_at", "lease_expires_at", "artifact_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "note_verification_claim_task_run_unique"
  ON "note_verification_claim" ("task_run_id") WHERE "task_run_id" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX "event_note_handoff_v1_recovery_idx"
  ON "event" ((payload ->> 'handoff_kind'), dispatch_seq, id, subject_id)
  WHERE action = 'experimental:note_handoff'
    AND payload ->> 'version' = '1'
    AND payload ->> 'artifact_id' = subject_id
    AND payload ->> 'handoff_kind' IN ('generation_intent', 'verification_intent');
--> statement-breakpoint
CREATE INDEX "event_note_handoff_v1_completion_idx"
  ON "event" (subject_id, (payload ->> 'handoff_kind'))
  WHERE action = 'experimental:note_handoff'
    AND payload ->> 'version' = '1'
    AND payload ->> 'artifact_id' = subject_id
    AND payload ->> 'handoff_kind' IN ('generation_dispatch_complete', 'verification_dispatch_complete');
--> statement-breakpoint
CREATE INDEX "artifact_note_handoff_legacy_idx"
  ON "artifact" (generation_status, verification_status, created_at, id)
  WHERE generation_status = 'pending'
     OR (generation_status = 'ready' AND verification_status = 'queued');
