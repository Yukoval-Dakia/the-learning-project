CREATE TABLE IF NOT EXISTS "echo_jobs" (
	"id" text PRIMARY KEY NOT NULL,
	"input" text NOT NULL,
	"output" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"error_md" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_events" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "job_events_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"business_table" text NOT NULL,
	"business_id" text NOT NULL,
	"event_type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "question_block" ALTER COLUMN "extracted_prompt_md" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD COLUMN "outcome" text DEFAULT 'success' NOT NULL;--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD COLUMN "pgboss_job_id" text;--> statement-breakpoint
ALTER TABLE "ingestion_session" ADD COLUMN "warnings" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "question_block" ADD COLUMN "structured" jsonb;--> statement-breakpoint
ALTER TABLE "question_block" ADD COLUMN "figures" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "question_block" ADD COLUMN "layout_quality" text DEFAULT 'structured' NOT NULL;