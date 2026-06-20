-- YUK-393 — embed re-embed-on-change freshness. Two nullable ADD COLUMNs only.
-- embed_content_hash = sha256 of the embed-source text. Existing rows that already
-- carry a non-NULL embedding get a NULL hash here (no backfill of the hash in this
-- migration); the hash is recomputed lazily on the next content mutation
-- (editQuestion / applyReparent) and stamped going forward by the embed_backfill
-- job at fill time. A NULL hash never triggers a re-embed by itself — staleness is
-- detected only by a recomputed hash DIFFERING from the stored one.
ALTER TABLE "knowledge" ADD COLUMN "embed_content_hash" text;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "embed_content_hash" text;
