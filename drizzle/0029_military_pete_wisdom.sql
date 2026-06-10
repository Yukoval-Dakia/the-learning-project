CREATE TABLE "practice_stream_item" (
	"id" text PRIMARY KEY NOT NULL,
	"date" text NOT NULL,
	"position" integer NOT NULL,
	"item_kind" text NOT NULL,
	"ref_id" text NOT NULL,
	"source" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"reasoning" text NOT NULL,
	"added_by" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "practice_stream_date_idx" ON "practice_stream_item" USING btree ("date","position");--> statement-breakpoint
CREATE UNIQUE INDEX "practice_stream_date_ref_unique" ON "practice_stream_item" USING btree ("date","ref_id");