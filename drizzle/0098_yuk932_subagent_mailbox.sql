CREATE TABLE "copilot_continuation" (
	"id" text PRIMARY KEY NOT NULL,
	"subagent_run_id" text NOT NULL,
	"session_id" text NOT NULL,
	"parent_turn_event_id" text NOT NULL,
	"result_event_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"claim_token" text,
	"lease_expires_at" timestamp with time zone,
	"task_run_id" text,
	"reply_event_id" text,
	"pg_boss_job_id" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "copilot_continuation_status_ck" CHECK ("copilot_continuation"."status" IN ('pending','running','succeeded','failed','cancelled','lost','skipped'))
);
--> statement-breakpoint
CREATE TABLE "subagent_run" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text NOT NULL,
	"parent_turn_event_id" text NOT NULL,
	"launch_key" text NOT NULL,
	"parent_task_run_id" text,
	"objective_hash" text NOT NULL,
	"objective" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"cancel_requested_by" text,
	"cancel_requested_at" timestamp with time zone,
	"claim_token" text,
	"lease_expires_at" timestamp with time zone,
	"hard_deadline_at" timestamp with time zone,
	"child_task_run_id" text,
	"started_event_id" text NOT NULL,
	"settled_event_id" text,
	"pg_boss_job_id" text,
	"result_md" text,
	"error_code" text,
	"error_message" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"settled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subagent_run_objective_hash_ck" CHECK ("subagent_run"."objective_hash" ~ '^[0-9a-f]{64}$'),
	CONSTRAINT "subagent_run_status_ck" CHECK ("subagent_run"."status" IN ('queued','running','succeeded','failed','cancelled','lost')),
	CONSTRAINT "subagent_run_cancel_owner_ck" CHECK ("subagent_run"."cancel_requested_by" IS NULL OR "subagent_run"."cancel_requested_by" IN ('model','system','user')),
	CONSTRAINT "subagent_run_bounds_ck" CHECK (char_length("subagent_run"."objective") BETWEEN 1 AND 12000 AND char_length("subagent_run"."launch_key") BETWEEN 1 AND 120)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "copilot_continuation_subagent_uq" ON "copilot_continuation" USING btree ("subagent_run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "copilot_continuation_result_event_uq" ON "copilot_continuation" USING btree ("result_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "copilot_continuation_one_running_per_session_uq" ON "copilot_continuation" USING btree ("session_id") WHERE "copilot_continuation"."status" = 'running';--> statement-breakpoint
CREATE INDEX "copilot_continuation_recovery_idx" ON "copilot_continuation" USING btree ("status","lease_expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "subagent_run_parent_launch_uq" ON "subagent_run" USING btree ("session_id","parent_turn_event_id","launch_key");--> statement-breakpoint
CREATE INDEX "subagent_run_recovery_idx" ON "subagent_run" USING btree ("status","lease_expires_at");