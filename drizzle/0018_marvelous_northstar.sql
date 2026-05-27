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
UPDATE "artifact"
SET "knowledge_ids" = jsonb_build_array("knowledge_id")
WHERE "knowledge_id" IS NOT NULL;--> statement-breakpoint
UPDATE "artifact"
SET "attrs" = "attrs" || jsonb_strip_nulls(jsonb_build_object(
	'outline_json', "outline_json",
	'child_artifact_ids', NULLIF("child_artifact_ids", '[]'::jsonb)
))
WHERE "outline_json" IS NOT NULL OR "child_artifact_ids" <> '[]'::jsonb;--> statement-breakpoint
UPDATE "artifact"
SET "body_blocks" = jsonb_build_object(
	'type', 'doc',
	'content', COALESCE(
		(
			SELECT jsonb_agg(
				jsonb_build_object(
					'type', 'semanticBlock',
					'attrs', jsonb_strip_nulls(jsonb_build_object(
						'id', section_value ->> 'id',
						'semantic_kind', section_value ->> 'kind',
						'source_tier', COALESCE(section_value ->> 'source_tier', 'llm_only'),
						'user_verified', COALESCE((section_value ->> 'user_verified')::boolean, false),
						'embedded_check', section_value -> 'embedded_check',
						'version', COALESCE((section_value ->> 'version')::integer, 0),
						'source_markdown', COALESCE(section_value ->> 'body_md', '')
					)),
					'content', jsonb_build_array(jsonb_build_object(
						'type', 'paragraph',
						'content', CASE
							WHEN COALESCE(section_value ->> 'body_md', '') = '' THEN '[]'::jsonb
							ELSE jsonb_build_array(jsonb_build_object('type', 'text', 'text', section_value ->> 'body_md'))
						END
					))
				)
				ORDER BY section_ord
			)
			FROM jsonb_array_elements("artifact"."sections") WITH ORDINALITY AS legacy_sections(section_value, section_ord)
		),
		'[]'::jsonb
	)
)
WHERE jsonb_typeof("sections") = 'array';--> statement-breakpoint
UPDATE "event"
SET "payload" = ("payload" - 'section_id') || CASE
	WHEN "payload" ? 'block_id' THEN '{}'::jsonb
	ELSE jsonb_build_object('block_id', "payload" ->> 'section_id')
END
WHERE "action" = 'correct'
	AND "subject_kind" = 'artifact'
	AND "payload" ? 'section_id';--> statement-breakpoint
ALTER TABLE "artifact_block_ref" ADD CONSTRAINT "artifact_block_ref_from_artifact_id_artifact_id_fk" FOREIGN KEY ("from_artifact_id") REFERENCES "public"."artifact"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "artifact_block_ref" ADD CONSTRAINT "artifact_block_ref_to_artifact_id_artifact_id_fk" FOREIGN KEY ("to_artifact_id") REFERENCES "public"."artifact"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "artifact_block_ref_to_idx" ON "artifact_block_ref" USING btree ("to_artifact_id","to_block_id");--> statement-breakpoint
CREATE UNIQUE INDEX "artifact_block_ref_unique" ON "artifact_block_ref" USING btree ("from_artifact_id","from_block_id","to_artifact_id",(COALESCE("to_block_id", '')));--> statement-breakpoint
CREATE INDEX "event_referenced_knowledge_gin" ON "event" USING gin ((payload -> 'referenced_knowledge_ids'));--> statement-breakpoint
ALTER TABLE "artifact" DROP COLUMN "knowledge_id";--> statement-breakpoint
ALTER TABLE "artifact" DROP COLUMN "child_artifact_ids";--> statement-breakpoint
ALTER TABLE "artifact" DROP COLUMN "outline_json";--> statement-breakpoint
ALTER TABLE "artifact" DROP COLUMN "sections";
