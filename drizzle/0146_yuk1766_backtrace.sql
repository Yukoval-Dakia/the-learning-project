CREATE TABLE "attempt_insight_vector" (
	"insight_event_id" text NOT NULL,
	"facet" text NOT NULL,
	"attempt_event_id" text NOT NULL,
	"question_id" text NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"embedding" vector(1024) NOT NULL,
	"embed_model" text NOT NULL,
	"embed_version" integer NOT NULL,
	"content_hash" text NOT NULL,
	CONSTRAINT "attempt_insight_vector_insight_event_id_facet_pk" PRIMARY KEY("insight_event_id","facet"),
	CONSTRAINT "attempt_insight_vector_facet_check" CHECK ("attempt_insight_vector"."facet" IN ('mechanism', 'method', 'needed_method'))
);
--> statement-breakpoint
CREATE TABLE "backtrace_work" (
	"id" text PRIMARY KEY NOT NULL,
	"attempt_event_id" text NOT NULL,
	"stage" text NOT NULL,
	"input_digest" text NOT NULL,
	"state" text NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
