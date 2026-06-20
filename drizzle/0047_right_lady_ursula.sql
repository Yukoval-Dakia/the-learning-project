CREATE TABLE "misconception" (
	"id" text PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"reasoning" text,
	"weight" real DEFAULT 1,
	"created_by" jsonb NOT NULL,
	"proposed_by_ai" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"archived_at" timestamp with time zone
);
