CREATE TABLE "agent_workspace" (
	"id" text PRIMARY KEY NOT NULL,
	"owner_kind" text NOT NULL,
	"owner_id" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"volume_id" text NOT NULL,
	"generation" integer DEFAULT 1 NOT NULL,
	"bytes" bigint DEFAULT 0 NOT NULL,
	"last_activity_at" timestamp with time zone DEFAULT now() NOT NULL,
	"execution_token" text,
	"execution_runtime" text,
	"delete_reason" text,
	"tombstoned_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "learning_session" ADD COLUMN "deletion_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_session" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_workspace_current_owner" ON "agent_workspace" USING btree ("owner_kind","owner_id") WHERE "agent_workspace"."state" IN ('active','revoking','tombstoned');--> statement-breakpoint
CREATE INDEX "agent_workspace_cleanup" ON "agent_workspace" USING btree ("state","last_activity_at");