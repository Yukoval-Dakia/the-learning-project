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
INSERT INTO "learning_record" (
	"id", "kind", "title", "content_md", "source", "capture_mode", "activity_kind",
	"processing_status", "origin_event_id", "subject_id", "knowledge_ids",
	"question_id", "attempt_event_id", "learning_item_id", "artifact_id",
	"source_document_id", "asset_refs", "payload", "created_at", "updated_at",
	"archived_at", "version"
)
SELECT
	"id",
	CASE "kind"
		WHEN 'highlight'   THEN 'observation'
		WHEN 'insight'     THEN 'insight'
		WHEN 'question'    THEN 'open_question'
		WHEN 'reflection'  THEN 'reflection'
		WHEN 'observation' THEN 'observation'
		ELSE 'observation'
	END AS "kind",
	NULL::text AS "title",
	"content_md",
	'manual' AS "source",
	'text' AS "capture_mode",
	CASE "kind"
		WHEN 'question' THEN 'ask'
		ELSE 'annotate'
	END AS "activity_kind",
	'raw' AS "processing_status",
	NULL::text AS "origin_event_id",
	NULL::text AS "subject_id",
	"knowledge_ids",
	"question_id",
	"mistake_id" AS "attempt_event_id",
	"learning_item_id",
	"artifact_id",
	NULL::text AS "source_document_id",
	'[]'::jsonb AS "asset_refs",
	'{}'::jsonb AS "payload",
	"created_at",
	"updated_at",
	NULL::timestamp with time zone AS "archived_at",
	"version"
FROM "study_log";--> statement-breakpoint
DROP TABLE "study_log" CASCADE;
