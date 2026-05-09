PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_knowledge` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`domain` text,
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
INSERT INTO `__new_knowledge`("id", "name", "domain", "parent_id", "base_mastery", "ai_delta_mastery", "last_active_at", "merged_from", "archived_at", "proposed_by_ai", "approval_status", "created_at", "updated_at", "version") SELECT "id", "name", "domain", "parent_id", "base_mastery", "ai_delta_mastery", "last_active_at", "merged_from", "archived_at", "proposed_by_ai", "approval_status", "created_at", "updated_at", "version" FROM `knowledge`;--> statement-breakpoint
DROP TABLE `knowledge`;--> statement-breakpoint
ALTER TABLE `__new_knowledge` RENAME TO `knowledge`;--> statement-breakpoint
PRAGMA foreign_keys=ON;