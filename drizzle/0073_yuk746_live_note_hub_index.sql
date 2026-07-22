CREATE INDEX "artifact_live_note_hub_idx" ON "artifact" USING btree ("id") WHERE "type" = 'note_hub' AND "archived_at" IS NULL;
