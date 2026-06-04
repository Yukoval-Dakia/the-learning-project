ALTER TABLE "answer" ALTER COLUMN "submitted_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "answer" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "answer" ADD COLUMN "paper_artifact_id" text;--> statement-breakpoint
ALTER TABLE "answer" ADD COLUMN "part_ref" text;--> statement-breakpoint
ALTER TABLE "answer" ADD COLUMN "event_id" text;--> statement-breakpoint
ALTER TABLE "answer" ADD COLUMN "autosaved_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "learning_session" ADD COLUMN "artifact_id" text;--> statement-breakpoint
-- U5 (YUK-203) — autosave partial unique index, HAND-WRITTEN.
-- drizzle-kit at this repo's version does NOT emit the partial-index `WHERE`
-- clause nor the COALESCE(...) expression-index (same limitation noted for the
-- YUK-101 outbox index in schema.ts; precedent: drizzle/0017, drizzle/0005, and
-- the COALESCE expression-index at drizzle/0018:64). Guarantees ONE live draft
-- per slot (session_id, question_id, part_ref); frozen rows (submitted_at IS NOT
-- NULL) are append-only history and excluded, so re-submission / rejudge after
-- abandon→reopen does not collide. COALESCE(part_ref,'') because Postgres treats
-- NULLs as distinct in unique indexes (atomic Qs have part_ref NULL).
CREATE UNIQUE INDEX "answer_draft_slot_uk" ON "answer" USING btree ("session_id","question_id",(COALESCE("part_ref", ''))) WHERE "submitted_at" IS NULL;