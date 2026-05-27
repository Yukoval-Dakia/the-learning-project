CREATE TABLE "artifact_block_ref" (
	"from_artifact_id" text NOT NULL,
	"from_block_id" text NOT NULL,
	"to_artifact_id" text NOT NULL,
	"to_block_id" text
);
--> statement-breakpoint
ALTER TABLE "artifact" ADD COLUMN "knowledge_ids" jsonb DEFAULT '[]'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact" ADD COLUMN "body_blocks" jsonb;--> statement-breakpoint
ALTER TABLE "artifact" ADD COLUMN "attrs" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact_block_ref" ADD CONSTRAINT "artifact_block_ref_from_artifact_id_artifact_id_fk" FOREIGN KEY ("from_artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_block_ref" ADD CONSTRAINT "artifact_block_ref_to_artifact_id_artifact_id_fk" FOREIGN KEY ("to_artifact_id") REFERENCES "public"."artifact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_block_ref_to_idx" ON "artifact_block_ref" USING btree ("to_artifact_id","to_block_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_block_ref_unique" ON "artifact_block_ref" USING btree ("from_artifact_id","from_block_id","to_artifact_id",(COALESCE("to_block_id", '')));--> statement-breakpoint
CREATE INDEX "event_referenced_knowledge_gin" ON "event" USING gin ((payload -> 'referenced_knowledge_ids'));--> statement-breakpoint
ALTER TABLE "artifact" DROP COLUMN "knowledge_id";--> statement-breakpoint
ALTER TABLE "artifact" DROP COLUMN "child_artifact_ids";--> statement-breakpoint
ALTER TABLE "artifact" DROP COLUMN "outline_json";--> statement-breakpoint
ALTER TABLE "artifact" DROP COLUMN "sections";
