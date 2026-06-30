CREATE TABLE "misconception_reconciliation_log" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_from_kind" text NOT NULL,
	"candidate_from_id" text NOT NULL,
	"candidate_to_kind" text NOT NULL,
	"candidate_to_id" text NOT NULL,
	"candidate_relation_type" text NOT NULL,
	"action" text NOT NULL,
	"superseded_edge_id" text,
	"confidence" real NOT NULL,
	"reason" text NOT NULL,
	"llm_raw" jsonb,
	"planned_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone,
	CONSTRAINT "misconception_recon_action_superseded_ck" CHECK (("misconception_reconciliation_log"."action" = 'SUPERSEDE' AND "misconception_reconciliation_log"."superseded_edge_id" IS NOT NULL) OR ("misconception_reconciliation_log"."action" = 'KEEP_BOTH' AND "misconception_reconciliation_log"."superseded_edge_id" IS NULL))
);
--> statement-breakpoint
CREATE INDEX "misconception_recon_candidate_idx" ON "misconception_reconciliation_log" USING btree ("candidate_from_id","candidate_to_id","candidate_relation_type");--> statement-breakpoint
CREATE INDEX "misconception_recon_unapplied_idx" ON "misconception_reconciliation_log" USING btree ("applied_at");--> statement-breakpoint
ALTER TABLE "misconception_edge" ADD CONSTRAINT "misconception_edge_weight_range" CHECK ("misconception_edge"."weight" BETWEEN 0 AND 1);