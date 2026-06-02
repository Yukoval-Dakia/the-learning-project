DROP INDEX "learning_item_primary_artifact_active_unique";--> statement-breakpoint
CREATE INDEX "learning_item_primary_artifact_idx" ON "learning_item" USING btree ("primary_artifact_id");