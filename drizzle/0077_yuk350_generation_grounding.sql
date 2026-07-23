CREATE TABLE "question_answer_anchor" (
  "id" text NOT NULL,
  "version" integer NOT NULL,
  "schema_version" integer NOT NULL,
  "source_artifact_kind" text NOT NULL,
  "source_artifact_id" text NOT NULL,
  "source_version" integer NOT NULL,
  "source_content_hash" text NOT NULL,
  "source_locator" jsonb NOT NULL,
  "canonical_answer" jsonb NOT NULL,
  "provenance" jsonb NOT NULL,
  "content_hash" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "question_answer_anchor_id_version_pk" PRIMARY KEY("id", "version")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "question_answer_anchor_content_hash_uq" ON "question_answer_anchor" USING btree ("content_hash");
--> statement-breakpoint
CREATE TABLE "question_generation_plan" (
  "id" text NOT NULL,
  "version" integer NOT NULL,
  "schema_version" integer NOT NULL,
  "demand" jsonb NOT NULL,
  "knowledge_ids" jsonb NOT NULL,
  "requested_kind" text NOT NULL,
  "requested_answer_class" text NOT NULL,
  "answer_anchor_id" text NOT NULL,
  "answer_anchor_version" integer NOT NULL,
  "answer_anchor_hash" text NOT NULL,
  "constraints" jsonb NOT NULL,
  "status" text NOT NULL,
  "provenance" jsonb NOT NULL,
  "content_hash" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "question_generation_plan_id_version_pk" PRIMARY KEY("id", "version"),
  CONSTRAINT "question_generation_plan_status_ck" CHECK ("status" IN ('pending_generation', 'generated', 'failed', 'superseded'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "question_generation_plan_content_hash_uq" ON "question_generation_plan" USING btree ("content_hash");
--> statement-breakpoint
CREATE INDEX "question_generation_plan_anchor_idx" ON "question_generation_plan" USING btree ("answer_anchor_id", "answer_anchor_version");
--> statement-breakpoint
CREATE TABLE "question_generation_binding" (
  "question_id" text PRIMARY KEY NOT NULL,
  "plan_id" text NOT NULL,
  "plan_version" integer NOT NULL,
  "plan_hash" text NOT NULL,
  "answer_anchor_id" text NOT NULL,
  "answer_anchor_version" integer NOT NULL,
  "answer_anchor_hash" text NOT NULL,
  "comparator_policy_id" text NOT NULL,
  "comparator_policy_version" integer NOT NULL,
  "comparator_policy_hash" text NOT NULL,
  "validation_status" text NOT NULL,
  "structural_status" text NOT NULL,
  "objective_correctness" text NOT NULL,
  "created_at" timestamp with time zone NOT NULL,
  CONSTRAINT "question_generation_binding_validation_status_ck" CHECK ("validation_status" IN ('pending', 'needs_review', 'rejected', 'verified')),
  CONSTRAINT "question_generation_binding_structural_status_ck" CHECK ("structural_status" IN ('no_veto', 'vetoed')),
  CONSTRAINT "question_generation_binding_objective_correctness_ck" CHECK ("objective_correctness" = 'unverified')
);
