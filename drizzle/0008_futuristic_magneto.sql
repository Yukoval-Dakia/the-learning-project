ALTER TABLE "artifact" ADD COLUMN "verification_status" text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "artifact" ADD COLUMN "verification_summary" jsonb;--> statement-breakpoint
ALTER TABLE "artifact" ADD COLUMN "verified_by" jsonb;