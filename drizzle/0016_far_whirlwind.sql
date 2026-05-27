ALTER TABLE "event" ADD COLUMN "affected_scopes" text[] DEFAULT ARRAY[]::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "memory_brief_note" ADD COLUMN "latest_evidence_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "memory_brief_note" ADD COLUMN "evidence_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX "event_affected_scopes_idx" ON "event" USING gin ("affected_scopes");