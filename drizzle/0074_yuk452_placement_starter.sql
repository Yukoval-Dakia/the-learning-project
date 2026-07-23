CREATE TABLE "placement_starter_attempt" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"pg_boss_job_id" text NOT NULL,
	"delivery_no" integer NOT NULL,
	"fencing_token" uuid NOT NULL,
	"status" text NOT NULL,
	"lease_expires_at" timestamp with time zone,
	"provider_task_run_id" text,
	"provider_output_hash" text,
	"provider_output_recorded_at" timestamp with time zone,
	"error_class" text,
	"error_code" text,
	"error_message" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "placement_starter_attempt_delivery_range" CHECK ("placement_starter_attempt"."delivery_no" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE TABLE "placement_starter_attempt_question" (
	"attempt_id" text NOT NULL,
	"claim_id" text NOT NULL,
	"question_id" text NOT NULL,
	"canonical_hash" text NOT NULL,
	"verification_authority_epoch" uuid NOT NULL,
	"verification_status" text DEFAULT 'authorized' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "placement_starter_attempt_question_attempt_id_question_id_pk" PRIMARY KEY("attempt_id","question_id")
);
--> statement-breakpoint
CREATE TABLE "placement_starter_claim" (
	"id" text PRIMARY KEY NOT NULL,
	"fingerprint" text NOT NULL,
	"goal_id" text NOT NULL,
	"semantic_goal_revision_id" text NOT NULL,
	"subject_id" text NOT NULL,
	"knowledge_id" text NOT NULL,
	"demand_id" text NOT NULL,
	"target_id" text NOT NULL,
	"status" text DEFAULT 'pending_dispatch' NOT NULL,
	"pg_boss_job_id" text,
	"max_paid_attempts" integer DEFAULT 3 NOT NULL,
	"budget_limit_micro_usd" integer DEFAULT 1000000 NOT NULL,
	"known_cost_micro_usd" integer DEFAULT 0 NOT NULL,
	"next_reconcile_at" timestamp with time zone DEFAULT now() NOT NULL,
	"satisfied_at" timestamp with time zone,
	"exhausted_at" timestamp with time zone,
	"last_error_class" text,
	"last_error_code" text,
	"last_error" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "placement_starter_claim_max_attempts_v1" CHECK ("placement_starter_claim"."max_paid_attempts" = 3),
	CONSTRAINT "placement_starter_claim_nonnegative_cost" CHECK ("placement_starter_claim"."budget_limit_micro_usd" >= 0 AND "placement_starter_claim"."known_cost_micro_usd" >= 0),
	CONSTRAINT "placement_starter_claim_terminal_timestamps" CHECK (("placement_starter_claim"."status" = 'satisfied') = ("placement_starter_claim"."satisfied_at" IS NOT NULL) AND ("placement_starter_claim"."status" = 'exhausted') = ("placement_starter_claim"."exhausted_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "placement_starter_cost_component" (
	"id" text PRIMARY KEY NOT NULL,
	"claim_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"component_kind" text NOT NULL,
	"question_id" text,
	"provider_task_run_id" text NOT NULL,
	"cost_micro_usd" integer NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "placement_starter_cost_component_nonnegative" CHECK ("placement_starter_cost_component"."cost_micro_usd" >= 0)
);
--> statement-breakpoint
ALTER TABLE "placement_starter_attempt" ADD CONSTRAINT "placement_starter_attempt_claim_id_placement_starter_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."placement_starter_claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_starter_attempt_question" ADD CONSTRAINT "placement_starter_attempt_question_attempt_id_placement_starter_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."placement_starter_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_starter_attempt_question" ADD CONSTRAINT "placement_starter_attempt_question_claim_id_placement_starter_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."placement_starter_claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_starter_attempt_question" ADD CONSTRAINT "placement_starter_attempt_question_question_id_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_starter_cost_component" ADD CONSTRAINT "placement_starter_cost_component_claim_id_placement_starter_claim_id_fk" FOREIGN KEY ("claim_id") REFERENCES "public"."placement_starter_claim"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_starter_cost_component" ADD CONSTRAINT "placement_starter_cost_component_attempt_id_placement_starter_attempt_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."placement_starter_attempt"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "placement_starter_cost_component" ADD CONSTRAINT "placement_starter_cost_component_question_id_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "placement_starter_attempt_fence_uq" ON "placement_starter_attempt" USING btree ("fencing_token");--> statement-breakpoint
CREATE UNIQUE INDEX "placement_starter_attempt_delivery_uq" ON "placement_starter_attempt" USING btree ("claim_id","pg_boss_job_id","delivery_no");--> statement-breakpoint
CREATE UNIQUE INDEX "placement_starter_attempt_active_uq" ON "placement_starter_attempt" USING btree ("claim_id") WHERE "placement_starter_attempt"."status" IN ('running','verifying');--> statement-breakpoint
CREATE UNIQUE INDEX "placement_starter_attempt_question_claim_uq" ON "placement_starter_attempt_question" USING btree ("claim_id","question_id");--> statement-breakpoint
CREATE UNIQUE INDEX "placement_starter_attempt_question_authority_uq" ON "placement_starter_attempt_question" USING btree ("attempt_id","question_id","verification_authority_epoch");--> statement-breakpoint
CREATE UNIQUE INDEX "placement_starter_claim_fingerprint_uq" ON "placement_starter_claim" USING btree ("fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "placement_starter_claim_revision_subject_uq" ON "placement_starter_claim" USING btree ("semantic_goal_revision_id","subject_id");--> statement-breakpoint
CREATE UNIQUE INDEX "placement_starter_claim_job_uq" ON "placement_starter_claim" USING btree ("pg_boss_job_id") WHERE "placement_starter_claim"."pg_boss_job_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "placement_starter_claim_nonterminal_uq" ON "placement_starter_claim" USING btree ("id") WHERE "placement_starter_claim"."status" IN ('pending_dispatch','queued','running','verifying','retry_scheduled');--> statement-breakpoint
CREATE INDEX "placement_starter_claim_recovery_idx" ON "placement_starter_claim" USING btree ("next_reconcile_at","created_at") WHERE "placement_starter_claim"."status" IN ('pending_dispatch','queued','running','verifying','retry_scheduled');--> statement-breakpoint
CREATE UNIQUE INDEX "placement_starter_cost_component_idempotency_uq" ON "placement_starter_cost_component" USING btree ("provider_task_run_id","component_kind",COALESCE("question_id", ''));