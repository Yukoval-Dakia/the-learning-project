CREATE TABLE "question_solution_prior" (
	"revision_id" text NOT NULL,
	"part_id" text NOT NULL,
	"prior_version" text NOT NULL,
	"prior" jsonb NOT NULL,
	"single_solver" boolean NOT NULL,
	"origin" text NOT NULL,
	"task_run_ids" jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	CONSTRAINT "question_solution_prior_revision_id_part_id_pk" PRIMARY KEY("revision_id","part_id"),
	CONSTRAINT "question_solution_prior_origin_ck" CHECK ("question_solution_prior"."origin" IN ('admission','backfill'))
);
--> statement-breakpoint
ALTER TABLE "question_solution_prior" ADD CONSTRAINT "question_solution_prior_revision_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."question_revision"("revision_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- Frozen per (revision, part): rewriting a prior is rejected by the shared guard.
CREATE TRIGGER "question_solution_prior_frozen"
  BEFORE UPDATE ON "question_solution_prior"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
