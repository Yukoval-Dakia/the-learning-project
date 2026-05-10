CREATE TABLE IF NOT EXISTS "answer" (
	"id" text PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"learning_item_id" text,
	"input_kind" text NOT NULL,
	"content_md" text DEFAULT '' NOT NULL,
	"image_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"vision_extracted" text,
	"tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"submitted_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "artifact" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"knowledge_id" text,
	"parent_artifact_id" text,
	"child_artifact_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"intent_source" text NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"outline_json" jsonb,
	"sections" jsonb,
	"tool_kind" text,
	"tool_state" jsonb,
	"generation_status" text DEFAULT 'pending' NOT NULL,
	"generated_by" jsonb,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "completion_evidence" (
	"id" text PRIMARY KEY NOT NULL,
	"learning_item_id" text NOT NULL,
	"path" text NOT NULL,
	"evidence_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"user_overrode_low_evidence" boolean DEFAULT false NOT NULL,
	"decided_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "cost_ledger" (
	"id" text PRIMARY KEY NOT NULL,
	"task_kind" text NOT NULL,
	"provider" text NOT NULL,
	"model" text NOT NULL,
	"cost" real NOT NULL,
	"tokens_in" integer NOT NULL,
	"tokens_out" integer NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dreaming_proposal" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"reasoning" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"proposed_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "ingestion_session" (
	"id" text PRIMARY KEY NOT NULL,
	"source_document_id" text,
	"source_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'uploaded' NOT NULL,
	"entrypoint" text NOT NULL,
	"error_message" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "judgment" (
	"id" text PRIMARY KEY NOT NULL,
	"answer_id" text NOT NULL,
	"judge_kind" text NOT NULL,
	"verdict" text NOT NULL,
	"score" real NOT NULL,
	"feedback_md" text NOT NULL,
	"evidence_json" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_flexible_fallback" boolean DEFAULT false NOT NULL,
	"triggered_by" text,
	"prior_judgment_id" text,
	"judged_by" jsonb NOT NULL,
	"judged_at" timestamp with time zone NOT NULL,
	"is_effective" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "knowledge" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"domain" text,
	"parent_id" text,
	"base_mastery" real DEFAULT 0 NOT NULL,
	"ai_delta_mastery" real DEFAULT 0 NOT NULL,
	"last_active_at" timestamp with time zone,
	"merged_from" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"archived_at" timestamp with time zone,
	"proposed_by_ai" boolean DEFAULT false NOT NULL,
	"approval_status" text DEFAULT 'approved' NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "learning_item" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"title" text NOT NULL,
	"content" text DEFAULT '' NOT NULL,
	"knowledge_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"primary_artifact_id" text,
	"parent_learning_item_id" text,
	"child_learning_item_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_pinned" boolean DEFAULT false NOT NULL,
	"ai_score" real,
	"due_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"dismissed_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"archived_reason" text,
	"reviewed_at" timestamp with time zone,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mistake" (
	"id" text PRIMARY KEY NOT NULL,
	"question_id" text NOT NULL,
	"wrong_answer_md" text,
	"wrong_answer_image_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"knowledge_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"cause" jsonb,
	"fsrs_state" jsonb,
	"variants" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"variants_generated_count" integer DEFAULT 0 NOT NULL,
	"variants_max" integer DEFAULT 3 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"archived_reason" text,
	"archived_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"delete_reason" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "question" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"prompt_md" text NOT NULL,
	"reference_md" text,
	"rubric_json" jsonb,
	"judge_kind_override" text,
	"visual_complexity" text,
	"knowledge_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"difficulty" integer DEFAULT 3 NOT NULL,
	"source" text NOT NULL,
	"source_ref" text,
	"draft_status" text,
	"variant_depth" integer DEFAULT 0 NOT NULL,
	"root_question_id" text,
	"parent_variant_id" text,
	"created_by" jsonb,
	"metadata" jsonb,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "question_block" (
	"id" text PRIMARY KEY NOT NULL,
	"ingestion_session_id" text NOT NULL,
	"source_document_id" text,
	"source_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"page_spans" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"extracted_prompt_md" text NOT NULL,
	"reference_md" text,
	"wrong_answer_md" text,
	"image_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"crop_refs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"visual_complexity" text DEFAULT 'low' NOT NULL,
	"extraction_confidence" real DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"knowledge_hint" text,
	"merged_from_block_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"imported_question_id" text,
	"imported_mistake_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "review_event" (
	"id" text PRIMARY KEY NOT NULL,
	"mistake_id" text NOT NULL,
	"rating" text NOT NULL,
	"response_md" text,
	"latency_ms" integer,
	"fsrs_state_before" jsonb,
	"fsrs_state_after" jsonb NOT NULL,
	"due_at_before" timestamp with time zone,
	"due_at_next" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_asset" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"storage_key" text NOT NULL,
	"mime_type" text NOT NULL,
	"byte_size" integer NOT NULL,
	"sha256" text NOT NULL,
	"width" integer,
	"height" integer,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "source_document" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text,
	"source_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"body_md" text,
	"provenance" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "study_log" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"content_md" text NOT NULL,
	"knowledge_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"question_id" text,
	"mistake_id" text,
	"artifact_id" text,
	"learning_item_id" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tool_call_log" (
	"id" text PRIMARY KEY NOT NULL,
	"task_run_id" text NOT NULL,
	"task_kind" text NOT NULL,
	"tool_name" text NOT NULL,
	"input_json" jsonb,
	"output_json" jsonb,
	"iteration" integer NOT NULL,
	"latency_ms" real NOT NULL,
	"cost" real NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_appeal" (
	"id" text PRIMARY KEY NOT NULL,
	"judgment_id" text NOT NULL,
	"reason" text,
	"appealed_at" timestamp with time zone NOT NULL,
	"resolved_judgment_id" text
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "mistake" ADD CONSTRAINT "mistake_question_id_question_id_fk" FOREIGN KEY ("question_id") REFERENCES "public"."question"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
