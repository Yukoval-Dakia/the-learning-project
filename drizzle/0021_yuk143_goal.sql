CREATE TABLE "goal" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"subject_id" text,
	"scope_knowledge_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"sequence_hint" integer DEFAULT 0 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "goal_status_idx" ON "goal" USING btree ("status","sequence_hint","created_at");--> statement-breakpoint
CREATE INDEX "goal_subject_idx" ON "goal" USING btree ("subject_id");