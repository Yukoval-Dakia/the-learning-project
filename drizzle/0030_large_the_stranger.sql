CREATE TABLE "editing_presence" (
	"artifact_id" text PRIMARY KEY NOT NULL,
	"status" text NOT NULL,
	"last_heartbeat_at" timestamp with time zone NOT NULL,
	"editing_started_at" timestamp with time zone,
	"pending" jsonb DEFAULT '[]'::jsonb NOT NULL
);
