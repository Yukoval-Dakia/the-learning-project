CREATE TABLE "event" (
	"id" text PRIMARY KEY NOT NULL,
	"session_id" text,
	"actor_kind" text NOT NULL,
	"actor_ref" text NOT NULL,
	"action" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"outcome" text,
	"payload" jsonb NOT NULL,
	"caused_by_event_id" text,
	"task_run_id" text,
	"cost_micro_usd" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "knowledge_edge" (
	"id" text PRIMARY KEY NOT NULL,
	"from_knowledge_id" text NOT NULL,
	"to_knowledge_id" text NOT NULL,
	"relation_type" text NOT NULL,
	"weight" real DEFAULT 1 NOT NULL,
	"created_by" jsonb NOT NULL,
	"reasoning" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "learning_session" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"status" text NOT NULL,
	"source_document_id" text,
	"source_asset_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"entrypoint" text,
	"warnings" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error_message" text,
	"summary_md" text,
	"goal_id" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"version" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "material_fsrs_state" (
	"id" text PRIMARY KEY NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"state" jsonb NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"last_review_event_id" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "judgment" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "user_appeal" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "judgment" CASCADE;--> statement-breakpoint
DROP TABLE "user_appeal" CASCADE;--> statement-breakpoint
ALTER TABLE "knowledge" DROP CONSTRAINT "knowledge_base_mastery_range";--> statement-breakpoint
ALTER TABLE "knowledge" DROP CONSTRAINT "knowledge_ai_delta_mastery_range";--> statement-breakpoint
ALTER TABLE "knowledge_edge" ADD CONSTRAINT "knowledge_edge_from_knowledge_id_knowledge_id_fk" FOREIGN KEY ("from_knowledge_id") REFERENCES "public"."knowledge"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "knowledge_edge" ADD CONSTRAINT "knowledge_edge_to_knowledge_id_knowledge_id_fk" FOREIGN KEY ("to_knowledge_id") REFERENCES "public"."knowledge"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "event_subject_idx" ON "event" USING btree ("subject_kind","subject_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "event_action_outcome_idx" ON "event" USING btree ("action","outcome","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "event_session_idx" ON "event" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "event_actor_idx" ON "event" USING btree ("actor_kind","actor_ref","created_at");--> statement-breakpoint
CREATE INDEX "event_caused_by_idx" ON "event" USING btree ("caused_by_event_id");--> statement-breakpoint
CREATE UNIQUE INDEX "knowledge_edge_unique" ON "knowledge_edge" USING btree ("from_knowledge_id","to_knowledge_id","relation_type");--> statement-breakpoint
CREATE INDEX "knowledge_edge_from_idx" ON "knowledge_edge" USING btree ("from_knowledge_id","relation_type");--> statement-breakpoint
CREATE INDEX "knowledge_edge_to_idx" ON "knowledge_edge" USING btree ("to_knowledge_id","relation_type");--> statement-breakpoint
CREATE UNIQUE INDEX "material_fsrs_unique" ON "material_fsrs_state" USING btree ("subject_kind","subject_id");--> statement-breakpoint
CREATE INDEX "material_fsrs_due_idx" ON "material_fsrs_state" USING btree ("due_at");--> statement-breakpoint
ALTER TABLE "knowledge" DROP COLUMN "base_mastery";--> statement-breakpoint
ALTER TABLE "knowledge" DROP COLUMN "ai_delta_mastery";--> statement-breakpoint
ALTER TABLE "knowledge" DROP COLUMN "last_active_at";