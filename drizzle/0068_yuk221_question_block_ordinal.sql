-- YUK-221 — question_block.ordinal: true 0-based positional order per
-- ingestion_session_id. A batch extracted in one shot shares ONE created_at
-- (applyExtractionResult takes `now` once before the insert loop), so the old
-- (created_at, id) sort degenerated to cuid2 `id` order WITHIN a batch — NOT the
-- real reading order. `ordinal` is written from the extraction/import array index
-- going forward; the /blocks + make-paper fall-through reads now order by it.
--
-- Backfill keeps historical batches identical to their current on-screen order:
-- rank each row within its session by (created_at ASC, id ASC) — the exact key the
-- pre-ordinal reads used — and store rank-1 (0-based) as ordinal. So same-created_at
-- historical batches keep the id tiebreak they show today; new data gets true order.
ALTER TABLE "question_block" ADD COLUMN "ordinal" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
UPDATE "question_block" qb
SET "ordinal" = sub.rn - 1
FROM (
	SELECT "id",
		ROW_NUMBER() OVER (
			PARTITION BY "ingestion_session_id"
			ORDER BY "created_at" ASC, "id" ASC
		) AS rn
	FROM "question_block"
) sub
WHERE qb."id" = sub."id";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "question_block_session_ordinal_idx" ON "question_block" ("ingestion_session_id", "ordinal");
