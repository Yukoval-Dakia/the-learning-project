ALTER TABLE "memory_reconciliation_log" ADD COLUMN "prev_text" text;--> statement-breakpoint
ALTER TABLE "memory_reconciliation_log" ADD COLUMN "prev_metadata" jsonb;