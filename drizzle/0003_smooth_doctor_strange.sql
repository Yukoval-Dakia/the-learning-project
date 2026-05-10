CREATE TABLE `ingestion_session` (
	`id` text PRIMARY KEY NOT NULL,
	`source_document_id` text,
	`source_asset_ids` text DEFAULT '[]' NOT NULL,
	`status` text DEFAULT 'uploaded' NOT NULL,
	`entrypoint` text NOT NULL,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `question_block` (
	`id` text PRIMARY KEY NOT NULL,
	`ingestion_session_id` text NOT NULL,
	`source_document_id` text,
	`source_asset_ids` text DEFAULT '[]' NOT NULL,
	`page_spans` text DEFAULT '[]' NOT NULL,
	`extracted_prompt_md` text NOT NULL,
	`reference_md` text,
	`wrong_answer_md` text,
	`image_refs` text DEFAULT '[]' NOT NULL,
	`crop_refs` text DEFAULT '[]' NOT NULL,
	`visual_complexity` text DEFAULT 'low' NOT NULL,
	`extraction_confidence` real DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'draft' NOT NULL,
	`knowledge_hint` text,
	`merged_from_block_ids` text DEFAULT '[]' NOT NULL,
	`imported_question_id` text,
	`imported_mistake_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `source_document` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text,
	`source_asset_ids` text DEFAULT '[]' NOT NULL,
	`body_md` text,
	`provenance` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
