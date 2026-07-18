-- YUK-535 — split whole-profile daily streams from KC-scoped on-demand review sessions.
-- `session_id` is a loose reference to learning_session.id (project convention: no enforced FK).
-- Existing rows remain daily rows because NULL is the partition discriminator.
ALTER TABLE "practice_stream_item" ADD COLUMN IF NOT EXISTS "session_id" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "practice_stream_session_idx"
	ON "practice_stream_item" USING btree ("session_id", "position");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "practice_stream_daily_ref_unique"
	ON "practice_stream_item" USING btree ("date", "ref_id")
	WHERE "session_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "practice_stream_session_ref_unique"
	ON "practice_stream_item" USING btree ("session_id", "ref_id")
	WHERE "session_id" IS NOT NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "practice_stream_date_ref_unique";
