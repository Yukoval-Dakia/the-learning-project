CREATE TABLE "memory_reconciliation_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"new_memory_id" text,
	"old_memory_id" text,
	"action" text NOT NULL,
	"reason" text NOT NULL,
	"llm_raw" jsonb,
	"planned_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "memory_recon_user_idx" ON "memory_reconciliation_log" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "memory_recon_unapplied_idx" ON "memory_reconciliation_log" USING btree ("applied_at");