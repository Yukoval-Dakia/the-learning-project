CREATE TABLE "assessment_identity_mapping" (
	"mapping_id" text PRIMARY KEY NOT NULL,
	"source_kind" text NOT NULL,
	"source_id" text NOT NULL,
	"source_locator" text NOT NULL,
	"original_question_id" text NOT NULL,
	"legacy_part_ref" text,
	"snapshot_digest" text,
	"target_revision_id" text,
	"target_part_id" text,
	"target_slot_id" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"algorithm_version" text NOT NULL,
	"status" text NOT NULL,
	"supersedes_mapping_id" text,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "assessment_identity_mapping_status_ck" CHECK ("assessment_identity_mapping"."status" IN ('pending','mapped','conflicted','historical_unresolved','superseded'))
);
--> statement-breakpoint
CREATE TABLE "assessment_issuance" (
	"issuance_id" text PRIMARY KEY NOT NULL,
	"revision_id" text NOT NULL,
	"part_ids" jsonb NOT NULL,
	"material_bindings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"option_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"container_occurrence_ref" text,
	"claim_policy" text NOT NULL,
	"claim_status" text NOT NULL,
	"claimed_by_ref" text,
	"issued_at" timestamp with time zone NOT NULL,
	CONSTRAINT "assessment_issuance_claim_policy_ck" CHECK ("assessment_issuance"."claim_policy" IN ('one_time','unbounded')),
	CONSTRAINT "assessment_issuance_claim_status_ck" CHECK ("assessment_issuance"."claim_status" IN ('unclaimed','claimed','released'))
);
--> statement-breakpoint
CREATE TABLE "assessment_submission" (
	"submission_id" text PRIMARY KEY NOT NULL,
	"issuance_id" text NOT NULL,
	"revision_id" text NOT NULL,
	"evaluation_group_id" text NOT NULL,
	"response_set" jsonb NOT NULL,
	"group_evidence" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"idempotency_key" text NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "evaluation" (
	"evaluation_id" text PRIMARY KEY NOT NULL,
	"evaluation_group_id" text NOT NULL,
	"submission_id" text NOT NULL,
	"attempt" integer NOT NULL,
	"status" text NOT NULL,
	"unit_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"aggregate" jsonb,
	"plan_digest" text,
	"run_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provenance" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "evaluation_status_ck" CHECK ("evaluation"."status" IN ('pending','completed')),
	CONSTRAINT "evaluation_attempt_positive_ck" CHECK ("evaluation"."attempt" >= 1)
);
--> statement-breakpoint
CREATE TABLE "evaluation_effective_head" (
	"evaluation_group_id" text PRIMARY KEY NOT NULL,
	"submission_id" text NOT NULL,
	"effective_evaluation_id" text,
	"generation" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "evaluation_effective_head_generation_ck" CHECK ("evaluation_effective_head"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "evaluation_group" (
	"evaluation_group_id" text PRIMARY KEY NOT NULL,
	"submission_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "evaluation_group_submission_ids_nonempty_ck" CHECK (jsonb_array_length("evaluation_group"."submission_ids") >= 1)
);
--> statement-breakpoint
CREATE TABLE "question_admission_verification" (
	"id" text PRIMARY KEY NOT NULL,
	"revision_id" text NOT NULL,
	"revision_digest" text NOT NULL,
	"policy_id" text NOT NULL,
	"generation" integer NOT NULL,
	"outcome" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"recorded_at" timestamp with time zone NOT NULL,
	CONSTRAINT "question_admission_verification_outcome_ck" CHECK ("question_admission_verification"."outcome" IN ('passed','suspended','failed')),
	CONSTRAINT "question_admission_verification_generation_ck" CHECK ("question_admission_verification"."generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "question_group_lifecycle" (
	"group_id" text PRIMARY KEY NOT NULL,
	"current_revision_id" text,
	"availability" text NOT NULL,
	"scoring_admission_state" text NOT NULL,
	"scoring_admission_evidence" jsonb,
	"scoring_admission_generation" integer DEFAULT 0 NOT NULL,
	"claim_policy" text NOT NULL,
	"suspended" boolean DEFAULT false NOT NULL,
	"suspension_reason" text,
	"withdrawn" boolean DEFAULT false NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "question_group_lifecycle_availability_ck" CHECK ("question_group_lifecycle"."availability" IN ('general_pool','container_only')),
	CONSTRAINT "question_group_lifecycle_admission_state_ck" CHECK ("question_group_lifecycle"."scoring_admission_state" IN ('admitted','withheld')),
	CONSTRAINT "question_group_lifecycle_claim_policy_ck" CHECK ("question_group_lifecycle"."claim_policy" IN ('one_time','unbounded')),
	CONSTRAINT "question_group_lifecycle_suspension_reason_ck" CHECK ("question_group_lifecycle"."suspension_reason" IN ('verify_hold','retraction_hold')),
	CONSTRAINT "question_group_lifecycle_admission_generation_ck" CHECK ("question_group_lifecycle"."scoring_admission_generation" >= 0)
);
--> statement-breakpoint
CREATE TABLE "question_revision" (
	"revision_id" text PRIMARY KEY NOT NULL,
	"group_id" text NOT NULL,
	"revision_ordinal" integer NOT NULL,
	"integrity_digest" text NOT NULL,
	"structure" jsonb NOT NULL,
	"response_spec" jsonb NOT NULL,
	"scoring_basis" jsonb NOT NULL,
	"execution_plan" jsonb NOT NULL,
	"supersedes_revision_id" text,
	"availability" text NOT NULL,
	"published_by" jsonb,
	"published_at" timestamp with time zone NOT NULL,
	CONSTRAINT "question_revision_availability_ck" CHECK ("question_revision"."availability" IN ('general_pool','container_only')),
	CONSTRAINT "question_revision_ordinal_positive_ck" CHECK ("question_revision"."revision_ordinal" >= 1)
);
--> statement-breakpoint
CREATE INDEX "assessment_identity_mapping_question_idx" ON "assessment_identity_mapping" USING btree ("original_question_id");--> statement-breakpoint
CREATE INDEX "assessment_identity_mapping_target_revision_idx" ON "assessment_identity_mapping" USING btree ("target_revision_id");--> statement-breakpoint
CREATE INDEX "assessment_issuance_revision_idx" ON "assessment_issuance" USING btree ("revision_id");--> statement-breakpoint
CREATE INDEX "assessment_issuance_container_ref_idx" ON "assessment_issuance" USING btree ("container_occurrence_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_submission_group_idem_uq" ON "assessment_submission" USING btree ("evaluation_group_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "assessment_submission_issuance_idx" ON "assessment_submission" USING btree ("issuance_id");--> statement-breakpoint
CREATE INDEX "assessment_submission_revision_idx" ON "assessment_submission" USING btree ("revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_submission_attempt_uq" ON "evaluation" USING btree ("submission_id","attempt");--> statement-breakpoint
CREATE INDEX "evaluation_group_idx" ON "evaluation" USING btree ("evaluation_group_id");--> statement-breakpoint
CREATE INDEX "evaluation_effective_head_submission_idx" ON "evaluation_effective_head" USING btree ("submission_id");--> statement-breakpoint
CREATE INDEX "question_admission_verification_revision_idx" ON "question_admission_verification" USING btree ("revision_id","generation");--> statement-breakpoint
CREATE INDEX "question_group_lifecycle_current_revision_idx" ON "question_group_lifecycle" USING btree ("current_revision_id");--> statement-breakpoint
CREATE UNIQUE INDEX "question_revision_group_ordinal_uq" ON "question_revision" USING btree ("group_id","revision_ordinal");--> statement-breakpoint
CREATE INDEX "question_revision_integrity_digest_idx" ON "question_revision" USING btree ("integrity_digest");--> statement-breakpoint
-- YUK-1044 — 活跃映射唯一性（§3.2）：同一 (source_kind, source_id, source_locator)
-- 只允许一条非 superseded 行；修正追加新行并把旧行置 superseded（证据保留，不覆盖）。
-- Hand-written partial index — drizzle-kit 不会 emit WHERE 子句（同 0028
-- answer_draft_slot_uk 先例），故不入 schema.ts 表定义，避免 db:generate 不完整重发。
CREATE UNIQUE INDEX "assessment_identity_mapping_active_uq"
  ON "assessment_identity_mapping" ("source_kind","source_id","source_locator")
  WHERE "status" <> 'superseded';
