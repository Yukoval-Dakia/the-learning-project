-- YUK-1603 — embed vector provenance revision. Two nullable ADD COLUMNs only.
--
-- embed_source_revision = the row `version` (question.version / knowledge.version)
-- the stored vector was computed from, stamped by the embed writers at write time
-- (embed_backfill both paths, questionEmbedStamp at ingest) and cleared wherever
-- `embedding` is NULLed (editQuestion / solution-generate / applyReparent). Existing
-- rows stay NULL: provenance unknown, still retrievable until the backfill's
-- provider-free currency sweep re-stamps them (content-hash verify) or re-embeds
-- (hash drifted). A non-NULL value behind the current `version` marks the vector
-- revision-stale — excluded from current retrieval by src/db/embed-currency.ts.
-- No data is rewritten here; no paid re-embed is implied by this migration.
ALTER TABLE "knowledge" ADD COLUMN "embed_source_revision" integer;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "embed_source_revision" integer;
