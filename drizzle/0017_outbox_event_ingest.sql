-- YUK-101 — transactional outbox for memory event ingest.
--
-- `ingest_at` is the outbox cursor: NULL means the event has not been
-- handed to the Mem0 ingest queue yet; NOT NULL means a poll-handler has
-- already enqueued the ingest job and stamped the row in the same tx that
-- did the SELECT…FOR UPDATE SKIP LOCKED. The partial index keeps the
-- "pending" scan O(pending rows) regardless of total event rows.
--
-- Existing event rows were already handed to the pre-outbox inline ingest path
-- when they were created. Mark them dispatched during the migration so the new
-- poller only sees rows written after this column exists.
--
-- See docs/adr/0021-event-write-outbox-pattern.md.
ALTER TABLE "event" ADD COLUMN "ingest_at" timestamp with time zone;--> statement-breakpoint
UPDATE "event" SET "ingest_at" = now() WHERE "ingest_at" IS NULL;--> statement-breakpoint
CREATE INDEX "event_ingest_pending_idx" ON "event" ("created_at") WHERE "ingest_at" IS NULL;
