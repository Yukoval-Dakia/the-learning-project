-- YUK-1497 (K5 presentation backend) — question_revision.presentation.
-- Frozen public presentation layer (Generative UI blocks-v1) as a nullable
-- jsonb column. Old rows stay NULL and keep the legacy per-slot rendering
-- (presentation spec v1 §3.7). Revisions carrying a presentation were
-- validated by validatePresentation in the publish barrier and the layer is
-- covered by integrity_digest (only when present — old digests unchanged).
-- Additive-only: no backfill, no constraint; the row-immutable triggers from
-- 0105/0111 keep guarding UPDATE/DELETE unchanged.
ALTER TABLE "question_revision" ADD COLUMN "presentation" jsonb;
