CREATE TABLE "dag_orchestration_node" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"job_name" text NOT NULL,
	"status" text NOT NULL,
	"boss_job_id" text,
	"stale" boolean DEFAULT false NOT NULL,
	"detail" text,
	"enqueued_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dag_orchestration_run" (
	"id" text PRIMARY KEY NOT NULL,
	"run_date" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "dag_orchestration_node_run_job_uq" ON "dag_orchestration_node" USING btree ("run_id","job_name");--> statement-breakpoint
CREATE INDEX "dag_orchestration_node_run_status_idx" ON "dag_orchestration_node" USING btree ("run_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "dag_orchestration_run_active_per_day_uq" ON "dag_orchestration_run" USING btree ("run_date") WHERE status = 'running';--> statement-breakpoint
CREATE INDEX "dag_orchestration_run_status_idx" ON "dag_orchestration_run" USING btree ("status");