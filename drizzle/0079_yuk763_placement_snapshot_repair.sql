-- YUK-763: placement lane schema↔migration-snapshot drift repair.
--
-- Background: migration 0075 (YUK-452, drizzle/0075_yuk452_placement_starter_integrity.sql)
-- correctly re-keyed placement_starter_claim_nonterminal_uq to (goal_id, subject_id) with a
-- predicate that EXCLUDES 'pending_dispatch', and added placement_starter_cost_component_claim_idx.
-- Those DDL changes shipped in the SQL chain and are present in every DB built from it, and the
-- 0075 meta snapshot captured them. But migration 0076 (YUK-751, #1044) regenerated its meta
-- snapshot from a stale base (the 0074 shape), silently dropping BOTH 0075 index changes from the
-- snapshot lineage (0076/0077/0078 snapshots). Consequence: schema.ts (the intended, 0075 shape)
-- diverged from the latest snapshot, so every `pnpm db:generate` re-emitted these two objects as
-- phantom drift, polluting unrelated lanes.
--
-- Intended side = schema.ts / the 0075 SQL. This migration realigns the snapshot lineage back to
-- reality. The DDL below is written IDEMPOTENT (IF EXISTS / IF NOT EXISTS): on any real DB — which
-- already carries the correct 0075 shape via the SQL chain — every statement is a safe no-op, while
-- the accompanying 0079 meta snapshot restores the correct shape so future db:generate emits empty.
DROP INDEX IF EXISTS "placement_starter_claim_nonterminal_uq";--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "placement_starter_cost_component_claim_idx" ON "placement_starter_cost_component" USING btree ("claim_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "placement_starter_claim_nonterminal_uq" ON "placement_starter_claim" USING btree ("goal_id","subject_id") WHERE "placement_starter_claim"."status" IN ('queued','running','verifying','retry_scheduled');
