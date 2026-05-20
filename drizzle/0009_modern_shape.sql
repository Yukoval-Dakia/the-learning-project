ALTER TABLE "artifact" ADD COLUMN "embedded_check_status" text DEFAULT 'not_required' NOT NULL;--> statement-breakpoint
ALTER TABLE "question" ADD COLUMN "choices_md" jsonb;