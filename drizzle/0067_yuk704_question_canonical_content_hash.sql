-- YUK-704 — exact question identity, separate from embedding freshness.
-- Existing rows intentionally remain NULL; Phase A performs no global backfill.
ALTER TABLE "question" ADD COLUMN "canonical_content_hash" text;
CREATE UNIQUE INDEX "question_canonical_content_hash_unique"
  ON "question" ("canonical_content_hash")
  WHERE "canonical_content_hash" IS NOT NULL;
