CREATE TABLE "selection_observation" (
	"id" text PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"stream_item_id" text,
	"ref_kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"policy" text NOT NULL,
	"selected" boolean NOT NULL,
	"inclusion_probability" real NOT NULL,
	"signals" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "practice_stream_item" ADD COLUMN "signals" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE INDEX "selection_observation_date_ref_idx" ON "selection_observation" USING btree ("date","ref_id");--> statement-breakpoint
CREATE INDEX "selection_observation_date_idx" ON "selection_observation" USING btree ("date");