CREATE SEQUENCE IF NOT EXISTS "learner_profile_refresh_intent_seq";
--> statement-breakpoint
CREATE TABLE "learner_profile" (
	"id" text PRIMARY KEY NOT NULL,
	"knowledge_id" text NOT NULL,
	"profile_version" integer DEFAULT 1 NOT NULL,
	"built_at" timestamp with time zone NOT NULL,
	"consumed_intent_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ability" jsonb,
	"p_correct_now" jsonb,
	"retention" jsonb,
	"evidence_timing" jsonb,
	"review_timing" jsonb,
	"ability_claim" jsonb,
	"uncertainty" jsonb,
	"would_change_it" jsonb,
	"patterns" jsonb,
	"corrections" jsonb,
	"retention_forecast" jsonb,
	"judgement" text,
	"component_versions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learner_profile_refresh_intent" (
	"id" text PRIMARY KEY NOT NULL,
	"seq" bigint DEFAULT nextval('learner_profile_refresh_intent_seq') NOT NULL,
	"knowledge_id" text NOT NULL,
	"source_kind" text NOT NULL,
	"source_ref" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"consumed_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "learner_profile_kc_unique" ON "learner_profile" USING btree ("knowledge_id");--> statement-breakpoint
CREATE UNIQUE INDEX "learner_profile_intent_idem_unique" ON "learner_profile_refresh_intent" USING btree ("knowledge_id","source_kind","source_ref");--> statement-breakpoint
CREATE INDEX "learner_profile_intent_pending_idx" ON "learner_profile_refresh_intent" USING btree ("consumed_at","seq");