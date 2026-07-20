-- YUK-736 — restore drizzle-kit's schema-diff baseline after hand-written migrations
-- 0064-0069 advanced the runtime schema and journal but did not retain generated snapshots.
-- The paired 0070_snapshot.json captures the already-applied current schema, so this migration
-- must not repeat its DDL. A harmless statement keeps migration runners and smoke tests explicit.
SELECT 1;
