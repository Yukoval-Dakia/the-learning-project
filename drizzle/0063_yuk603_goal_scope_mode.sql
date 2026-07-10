ALTER TABLE "goal" ADD COLUMN "scope_mode" text DEFAULT 'explicit' NOT NULL;--> statement-breakpoint
-- YUK-603 data-fix (v2 contract §5.3, 判据收紧防误伤): flip the ARMED legacy shape —
-- manual + subject + frozen scope that is empty or EXACTLY the single synthetic seed root —
-- to subject_live and clear the pinned scope. Everything else stays 'explicit' (the ADD
-- COLUMN default above): proposal-sourced rows keep their evidence-first frozen set, and a
-- manual multi-element / non-root set is treated as a hand-picked scope (conservative — never
-- silently widen a narrow goal).
--
-- fold==row caveat (documented, accepted): rows converted here had their genesis event
-- written with the OLD frozen scope and no scope_mode key, so ANY consumer that re-folds them
-- (the offline projection audit / capture-golden sweep, or a later status/scope update's
-- in-tx parity assert) would report a scope_mode + scope_knowledge_ids diff against this SQL
-- fix. The load-bearing guarantee is that production carries ZERO matching rows at ship time
-- (day-zero census + pre-merge diagnostic, YUK-603) — the UPDATE below is a no-op there; a
-- compensating event is deliberately not minted from SQL. A non-prod DB that DID carry an
-- armed row will read the (accurate) drift in the offline audit until re-seeded.
UPDATE "goal"
SET "scope_mode" = 'subject_live',
    "scope_knowledge_ids" = '[]'::jsonb
WHERE "source" = 'manual'
  AND "subject_id" IS NOT NULL
  AND (
    jsonb_array_length("scope_knowledge_ids") = 0
    OR (
      jsonb_array_length("scope_knowledge_ids") = 1
      AND "scope_knowledge_ids"->>0 LIKE 'seed:%:root'
    )
  );
