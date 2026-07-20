-- YUK-733 — index the three jsonb knowledge-id columns read with the `@>`
-- containment operator that currently fall back to a sequential scan.
-- jsonb_path_ops supports the `@>` operator these call sites use and produces a
-- smaller/faster index than the default jsonb_ops (mirrors the artifact /
-- question precedents in drizzle/0026 + question_knowledge_ids_gin).
--   learning_record.knowledge_ids — query_records AI tool + listLearningRecords
--     (src/server/ai/tools/context-readers.ts, src/server/records/queries.ts)
--     over the append-only, never-pruned evidence log.
--   learning_item.knowledge_ids  — user-facing note-page related items
--     (src/capabilities/notes/server/note-page.ts) + KC-merge rewrites.
--   goal.scope_knowledge_ids     — KC-merge scope rewrite
--     (src/capabilities/knowledge/server/proposals.ts) + orphan-surface backfill.
CREATE INDEX IF NOT EXISTS "learning_record_knowledge_ids_gin"
ON "learning_record" USING GIN ("knowledge_ids" jsonb_path_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "learning_item_knowledge_ids_gin"
ON "learning_item" USING GIN ("knowledge_ids" jsonb_path_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "goal_scope_knowledge_ids_gin"
ON "goal" USING GIN ("scope_knowledge_ids" jsonb_path_ops);
