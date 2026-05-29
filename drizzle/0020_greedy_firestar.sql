-- YUK-95 P5 (Wave 7 D4) — add `ref_kind` discriminator to artifact_block_ref so
-- the generic cross_link write-through (`syncBlockRefsForArtifact`) can full-recompute
-- its own rows without clobbering the embedded_check quiz refs.
--
-- Column default is 'cross_link' (the value the cross_link writer inserts), but
-- ALL pre-existing rows were written by the ONLY prior writer —
-- `embedded_check_generate.ts` (the inline quiz ref). The DEFAULT would mislabel
-- those as 'cross_link', so the backfill UPDATE below relabels every pre-existing
-- row to 'embedded_check'. This UPDATE is safe to run on an empty table (no-op)
-- and runs once at migrate time, before any cross_link row can exist.
ALTER TABLE "artifact_block_ref" ADD COLUMN "ref_kind" text DEFAULT 'cross_link' NOT NULL;
--> statement-breakpoint
UPDATE "artifact_block_ref" SET "ref_kind" = 'embedded_check';
