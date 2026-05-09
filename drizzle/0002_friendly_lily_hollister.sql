CREATE TABLE `source_asset` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`storage_key` text NOT NULL,
	`mime_type` text NOT NULL,
	`byte_size` integer NOT NULL,
	`sha256` text NOT NULL,
	`width` integer,
	`height` integer,
	`provenance` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL
);
