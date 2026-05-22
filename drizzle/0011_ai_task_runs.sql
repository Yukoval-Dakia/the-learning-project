CREATE TABLE "ai_task_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_kind" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"input_hash" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"finish_reason" text,
	"usage_json" jsonb DEFAULT '{"inputTokens":0,"outputTokens":0}'::jsonb NOT NULL,
	"cost_usd" real,
	"error_message" text,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "ai_task_runs_task_kind_idx" ON "ai_task_runs" USING btree ("task_kind","started_at" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX "ai_task_runs_status_idx" ON "ai_task_runs" USING btree ("status","started_at" DESC NULLS LAST);
--> statement-breakpoint
ALTER TABLE "cost_ledger" ADD COLUMN "task_run_id" text;
--> statement-breakpoint
CREATE INDEX "cost_ledger_task_run_idx" ON "cost_ledger" USING btree ("task_run_id");
