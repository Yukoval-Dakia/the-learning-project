CREATE TABLE `answer` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`learning_item_id` text,
	`input_kind` text NOT NULL,
	`content_md` text DEFAULT '' NOT NULL,
	`image_refs` text DEFAULT '[]' NOT NULL,
	`vision_extracted` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`submitted_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `artifact` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`title` text NOT NULL,
	`knowledge_id` text,
	`parent_artifact_id` text,
	`child_artifact_ids` text DEFAULT '[]' NOT NULL,
	`intent_source` text NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`outline_json` text,
	`sections` text,
	`tool_kind` text,
	`tool_state` text,
	`generation_status` text DEFAULT 'pending' NOT NULL,
	`generated_by` text,
	`history` text DEFAULT '[]' NOT NULL,
	`archived_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `completion_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`learning_item_id` text NOT NULL,
	`path` text NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`user_overrode_low_evidence` integer DEFAULT false NOT NULL,
	`decided_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cost_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`task_kind` text NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`cost` real NOT NULL,
	`tokens_in` integer NOT NULL,
	`tokens_out` integer NOT NULL,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `dreaming_proposal` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text NOT NULL,
	`reasoning` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`proposed_at` integer NOT NULL,
	`decided_at` integer
);
--> statement-breakpoint
CREATE TABLE `judgment` (
	`id` text PRIMARY KEY NOT NULL,
	`answer_id` text NOT NULL,
	`judge_kind` text NOT NULL,
	`verdict` text NOT NULL,
	`score` real NOT NULL,
	`feedback_md` text NOT NULL,
	`evidence_json` text DEFAULT '{}' NOT NULL,
	`is_flexible_fallback` integer DEFAULT false NOT NULL,
	`triggered_by` text,
	`prior_judgment_id` text,
	`judged_by` text NOT NULL,
	`judged_at` integer NOT NULL,
	`is_effective` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE `knowledge` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`domain` text NOT NULL,
	`parent_id` text,
	`base_mastery` real DEFAULT 0 NOT NULL,
	`ai_delta_mastery` real DEFAULT 0 NOT NULL,
	`last_active_at` integer,
	`merged_from` text DEFAULT '[]' NOT NULL,
	`archived_at` integer,
	`proposed_by_ai` integer DEFAULT false NOT NULL,
	`approval_status` text DEFAULT 'approved' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `learning_item` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`title` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`knowledge_ids` text DEFAULT '[]' NOT NULL,
	`primary_artifact_id` text,
	`parent_learning_item_id` text,
	`child_learning_item_ids` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`user_pinned` integer DEFAULT false NOT NULL,
	`ai_score` real,
	`due_at` integer,
	`completed_at` integer,
	`dismissed_at` integer,
	`archived_at` integer,
	`archived_reason` text,
	`reviewed_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `mistake` (
	`id` text PRIMARY KEY NOT NULL,
	`question_id` text NOT NULL,
	`wrong_answer_md` text,
	`wrong_answer_image_refs` text DEFAULT '[]' NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`knowledge_ids` text DEFAULT '[]' NOT NULL,
	`cause` text,
	`fsrs_state` text,
	`variants` text DEFAULT '[]' NOT NULL,
	`variants_generated_count` integer DEFAULT 0 NOT NULL,
	`variants_max` integer DEFAULT 3 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`archived_reason` text,
	`archived_at` integer,
	`deleted_at` integer,
	`delete_reason` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`question_id`) REFERENCES `question`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `question` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`prompt_md` text NOT NULL,
	`reference_md` text,
	`rubric_json` text,
	`judge_kind_override` text,
	`visual_complexity` text,
	`knowledge_ids` text DEFAULT '[]' NOT NULL,
	`difficulty` integer DEFAULT 3 NOT NULL,
	`source` text NOT NULL,
	`source_ref` text,
	`draft_status` text,
	`variant_depth` integer DEFAULT 0 NOT NULL,
	`root_question_id` text,
	`parent_variant_id` text,
	`created_by` text,
	`metadata` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `study_log` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`content_md` text NOT NULL,
	`knowledge_ids` text DEFAULT '[]' NOT NULL,
	`question_id` text,
	`mistake_id` text,
	`artifact_id` text,
	`learning_item_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `tool_call_log` (
	`id` text PRIMARY KEY NOT NULL,
	`task_run_id` text NOT NULL,
	`task_kind` text NOT NULL,
	`tool_name` text NOT NULL,
	`input_json` text,
	`output_json` text,
	`iteration` integer NOT NULL,
	`latency_ms` real NOT NULL,
	`cost` real NOT NULL,
	`occurred_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_appeal` (
	`id` text PRIMARY KEY NOT NULL,
	`judgment_id` text NOT NULL,
	`reason` text,
	`appealed_at` integer NOT NULL,
	`resolved_judgment_id` text
);
