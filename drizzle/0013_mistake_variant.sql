CREATE TABLE "mistake_variant" (
	"id" text PRIMARY KEY NOT NULL,
	"parent_question_id" text NOT NULL,
	"variant_question_id" text,
	"proposal_event_id" text,
	"status" text NOT NULL,
	"failure_reasons" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cause_category" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "mistake_variant_parent_idx" ON "mistake_variant" USING btree ("parent_question_id");--> statement-breakpoint
CREATE INDEX "mistake_variant_status_idx" ON "mistake_variant" USING btree ("status");