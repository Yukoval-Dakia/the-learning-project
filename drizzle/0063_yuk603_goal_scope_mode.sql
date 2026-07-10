ALTER TABLE "goal" ADD COLUMN "scope_mode" text DEFAULT 'explicit' NOT NULL;--> statement-breakpoint
-- YUK-603 data-fix (v2 contract §5.3, 判据收紧防误伤): flip the ARMED legacy shape —
-- manual + subject + frozen scope that is empty or EXACTLY the single synthetic seed root —
-- to subject_live and clear the pinned scope. Everything else stays 'explicit' (the ADD
-- COLUMN default above): proposal-sourced rows keep their evidence-first frozen set, and a
-- manual multi-element / non-root set is treated as a hand-picked scope (conservative — never
-- silently widen a narrow goal).
--
-- fold==row caveat (documented, accepted): rows converted here had their genesis event
-- written with the OLD frozen scope and no scope_mode key, so a LATER status/scope update's
-- parity assert would diff against this SQL fix. Production carries ZERO matching rows at
-- ship time (day-zero census + pre-merge diagnostic, YUK-603), and the status/scope helpers
-- have no live caller today; a compensating event is deliberately not minted from SQL.
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
