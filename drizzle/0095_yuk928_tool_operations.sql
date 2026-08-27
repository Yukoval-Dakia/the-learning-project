CREATE TABLE "tool_operation" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"task_run_id" text,
	"tool_name" text NOT NULL,
	"effect" text NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"process_id" text NOT NULL,
	"input_json" jsonb NOT NULL,
	"result_json" jsonb,
	"error_json" jsonb,
	"side_effect_risk" text,
	"cancelled_by" text,
	"terminal_tool_call_log_id" text,
	"hard_deadline_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tool_operation_effect_ck" CHECK ("tool_operation"."effect" IN ('read','propose','write')),
	CONSTRAINT "tool_operation_status_ck" CHECK ("tool_operation"."status" IN ('running','succeeded','failed','cancelled','lost')),
	CONSTRAINT "tool_operation_cancelled_by_ck" CHECK ("tool_operation"."cancelled_by" IS NULL OR "tool_operation"."cancelled_by" IN ('model','system','user')),
	CONSTRAINT "tool_operation_terminal_shape_ck" CHECK ((
        "tool_operation"."status" = 'running'
        AND "tool_operation"."settled_at" IS NULL
        AND "tool_operation"."result_json" IS NULL
        AND "tool_operation"."error_json" IS NULL
        AND "tool_operation"."side_effect_risk" IS NULL
        AND "tool_operation"."cancelled_by" IS NULL
      ) OR (
        "tool_operation"."status" = 'succeeded'
        AND "tool_operation"."settled_at" IS NOT NULL
        AND "tool_operation"."error_json" IS NULL
        AND "tool_operation"."side_effect_risk" IS NULL
        AND "tool_operation"."cancelled_by" IS NULL
      ) OR (
        "tool_operation"."status" = 'failed'
        AND "tool_operation"."settled_at" IS NOT NULL
        AND "tool_operation"."result_json" IS NULL
        AND "tool_operation"."error_json" IS NOT NULL
        AND "tool_operation"."side_effect_risk" IS NULL
        AND "tool_operation"."cancelled_by" IS NULL
      ) OR (
        "tool_operation"."status" = 'cancelled'
        AND "tool_operation"."settled_at" IS NOT NULL
        AND "tool_operation"."result_json" IS NULL
        AND "tool_operation"."error_json" IS NOT NULL
        AND "tool_operation"."side_effect_risk" IS NULL
        AND "tool_operation"."cancelled_by" IS NOT NULL
      ) OR (
        "tool_operation"."status" = 'lost'
        AND "tool_operation"."settled_at" IS NOT NULL
        AND "tool_operation"."result_json" IS NULL
        AND "tool_operation"."error_json" IS NOT NULL
        AND "tool_operation"."side_effect_risk" IN ('none','possible')
        AND "tool_operation"."cancelled_by" IS NULL
      )),
	CONSTRAINT "tool_operation_timeline_ck" CHECK ("tool_operation"."settled_at" IS NULL OR "tool_operation"."settled_at" >= "tool_operation"."started_at")
);
--> statement-breakpoint
CREATE INDEX "tool_operation_running_process_idx" ON "tool_operation" USING btree ("status","process_id");--> statement-breakpoint
CREATE INDEX "tool_operation_session_idx" ON "tool_operation" USING btree ("session_id","started_at");