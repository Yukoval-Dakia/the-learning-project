CREATE TABLE `review_event` (
	`id` text PRIMARY KEY NOT NULL,
	`mistake_id` text NOT NULL,
	`rating` text NOT NULL,
	`response_md` text,
	`latency_ms` integer,
	`fsrs_state_before` text,
	`fsrs_state_after` text NOT NULL,
	`due_at_before` integer,
	`due_at_next` integer NOT NULL,
	`created_at` integer NOT NULL
);
