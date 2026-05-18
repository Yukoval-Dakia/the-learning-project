ALTER TABLE "question_block" RENAME COLUMN "imported_mistake_id" TO "imported_attempt_event_id";--> statement-breakpoint
CREATE TABLE "learning_record" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"title" text,
	"content_md" text DEFAULT '' NOT NULL,
	"source" text NOT NULL,
	"capture_mode" text NOT NULL,
	"activity_kind" text NOT NULL,
	"processing_status" text DEFAULT 'raw' NOT NULL,
	"origin_event_id" text,
	"subject_id" text,
	"knowledge_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"question_id" text,
	"attempt_event_id" text,
	"learning_item_id" text,
	"artifact_id" text,
	"source_document_id" text,
	"asset_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE INDEX "learning_record_kind_created_idx" ON "learning_record" USING btree ("kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "learning_record_question_idx" ON "learning_record" USING btree ("question_id");--> statement-breakpoint
CREATE INDEX "learning_record_attempt_idx" ON "learning_record" USING btree ("attempt_event_id");--> statement-breakpoint
CREATE INDEX "learning_record_origin_event_idx" ON "learning_record" USING btree ("origin_event_id");--> statement-breakpoint
CREATE TABLE "memory_brief_note" (
	"id" text PRIMARY KEY NOT NULL,
	"scope_key" text NOT NULL,
	"subject_id" text,
	"recent_week_md" text DEFAULT '' NOT NULL,
	"recent_months_md" text DEFAULT '' NOT NULL,
	"long_term_md" text DEFAULT '' NOT NULL,
	"recent_week_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recent_months_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"long_term_evidence_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source_event_id" text,
	"refreshed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "memory_brief_note_scope_key_unique" ON "memory_brief_note" USING btree ("scope_key");--> statement-breakpoint
DROP TABLE "study_log" CASCADE;
