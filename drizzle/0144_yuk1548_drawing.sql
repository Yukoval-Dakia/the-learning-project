CREATE TABLE "drawing" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"dedupe_key" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"attempt" integer DEFAULT 1 NOT NULL,
	"brief" text NOT NULL,
	"alt" text NOT NULL,
	"caption" text,
	"sources" jsonb NOT NULL,
	"source_complete" boolean NOT NULL,
	"source_epochs" jsonb NOT NULL,
	"last_ready_asset_id" text,
	"last_ready_asset_digest" text,
	"last_ready_task_run_id" text,
	"sol_task_run_id" text,
	"copilot_task_run_id" text NOT NULL,
	"source_event_id" text,
	"error_kind" text,
	"error_detail" text,
	"retry_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "drawing_session_idx" ON "drawing" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "drawing_status_retry_idx" ON "drawing" USING btree ("retry_at") WHERE "drawing"."status" IN ('waiting_quota','waiting_login');--> statement-breakpoint
CREATE UNIQUE INDEX "drawing_dedupe_live_idx" ON "drawing" USING btree ("dedupe_key") WHERE "drawing"."status" IN ('queued','running','ready','waiting_quota','waiting_login');