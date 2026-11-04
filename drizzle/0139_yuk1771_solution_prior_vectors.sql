CREATE TABLE "question_solution_prior_backfill_attempt" (
	"revision_id" text PRIMARY KEY NOT NULL,
	"backfill_run_id" text NOT NULL,
	"status" text NOT NULL,
	"task_run_id" text,
	"reason" text,
	"attempted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "question_solution_prior_backfill_attempt_status_ck" CHECK ("question_solution_prior_backfill_attempt"."status" IN ('started','produced','empty','failed','skipped'))
);
--> statement-breakpoint
CREATE TABLE "question_solution_prior_vector" (
	"revision_id" text NOT NULL,
	"part_id" text NOT NULL,
	"facet" text NOT NULL,
	"idx" integer NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"embed_model" text NOT NULL,
	"embed_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	CONSTRAINT "question_solution_prior_vector_revision_id_part_id_facet_idx_pk" PRIMARY KEY("revision_id","part_id","facet","idx"),
	CONSTRAINT "question_solution_prior_vector_facet_ck" CHECK ("question_solution_prior_vector"."facet" IN ('method','pitfall'))
);
--> statement-breakpoint
ALTER TABLE "question_solution_prior" ADD COLUMN "backfill_run_id" text;--> statement-breakpoint
ALTER TABLE "question_solution_prior_backfill_attempt" ADD CONSTRAINT "question_solution_prior_backfill_attempt_revision_id_question_revision_revision_id_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."question_revision"("revision_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "question_solution_prior_vector" ADD CONSTRAINT "question_solution_prior_vector_prior_fk" FOREIGN KEY ("revision_id","part_id") REFERENCES "public"."question_solution_prior"("revision_id","part_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "question_solution_prior_backfill_attempt_run_idx" ON "question_solution_prior_backfill_attempt" USING btree ("backfill_run_id");--> statement-breakpoint
CREATE INDEX "question_solution_prior_backfill_idx" ON "question_solution_prior" USING btree ("backfill_run_id");--> statement-breakpoint
ALTER TABLE "question_solution_prior" ADD CONSTRAINT "question_solution_prior_backfill_ck" CHECK (("question_solution_prior"."origin" = 'backfill') = ("question_solution_prior"."backfill_run_id" IS NOT NULL));