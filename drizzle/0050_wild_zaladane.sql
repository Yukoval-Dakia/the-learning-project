CREATE TABLE "materialized_id_index" (
	"materialized_id" text PRIMARY KEY NOT NULL,
	"anchor_event_id" text NOT NULL,
	"subject_kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "materialized_id_index_anchor_idx" ON "materialized_id_index" USING btree ("anchor_event_id");