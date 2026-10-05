CREATE TABLE "copilot_evidence_checkpoint" (
	"id" text PRIMARY KEY NOT NULL,
	"task_kind" text NOT NULL,
	"slot" text NOT NULL,
	"protocol_version" integer NOT NULL,
	"prompt_fingerprint" text NOT NULL,
	"base_input_sha256" text NOT NULL,
	"source_catalog_sha256" text NOT NULL,
	"binding_extras" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"records_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"record_digests_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"attempts_json" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sealed_output_json" jsonb,
	"sealed_digest_sha256" text,
	"sealed_task_run_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	CONSTRAINT "copilot_evidence_checkpoint_task_kind_ck" CHECK ("copilot_evidence_checkpoint"."task_kind" IN ('CopilotEvidenceReviewTask','CopilotEvidenceVerificationTask')),
	CONSTRAINT "copilot_evidence_checkpoint_status_ck" CHECK ("copilot_evidence_checkpoint"."status" IN ('open','sealed','expired')),
	CONSTRAINT "copilot_evidence_checkpoint_revision_ck" CHECK ("copilot_evidence_checkpoint"."revision" >= 0),
	CONSTRAINT "copilot_evidence_checkpoint_seal_ck" CHECK ((
		"copilot_evidence_checkpoint"."status" = 'open'
		AND "copilot_evidence_checkpoint"."sealed_output_json" IS NULL
		AND "copilot_evidence_checkpoint"."sealed_digest_sha256" IS NULL
		AND "copilot_evidence_checkpoint"."sealed_task_run_id" IS NULL
	) OR (
		"copilot_evidence_checkpoint"."status" = 'sealed'
		AND "copilot_evidence_checkpoint"."sealed_output_json" IS NOT NULL
		AND "copilot_evidence_checkpoint"."sealed_digest_sha256" IS NOT NULL
		AND "copilot_evidence_checkpoint"."sealed_task_run_id" IS NOT NULL
	) OR (
		"copilot_evidence_checkpoint"."status" = 'expired'
		AND "copilot_evidence_checkpoint"."sealed_output_json" IS NULL
		AND "copilot_evidence_checkpoint"."sealed_digest_sha256" IS NULL
		AND "copilot_evidence_checkpoint"."sealed_task_run_id" IS NULL
	))
);
--> statement-breakpoint
CREATE INDEX "copilot_evidence_checkpoint_expiry_idx" ON "copilot_evidence_checkpoint" USING btree ("expires_at");
