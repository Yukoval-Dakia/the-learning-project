CREATE TABLE "cause_category_overlay" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_id" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"source" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"proposal_event_id" text,
	"evidence_event_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "cause_category_overlay_subject_idx" ON "cause_category_overlay" USING btree ("subject_id","status");