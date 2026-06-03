-- YUK-203 P1 review follow-up:
-- notesForKnowledge / notesForItem read artifact labels through
-- artifact.knowledge_ids @> '["knowledge_id"]'::jsonb. Keep that membership
-- query indexed as note and quiz artifacts grow.
CREATE INDEX IF NOT EXISTS "artifact_knowledge_ids_gin_idx"
ON "artifact" USING GIN ("knowledge_ids" jsonb_path_ops);
