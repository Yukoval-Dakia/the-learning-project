CREATE TABLE "edge_reconciliation_log" (
	"id" text PRIMARY KEY NOT NULL,
	"candidate_from_knowledge_id" text NOT NULL,
	"candidate_to_knowledge_id" text NOT NULL,
	"candidate_relation_type" text NOT NULL,
	"action" text NOT NULL,
	"superseded_edge_id" text,
	"confidence" real NOT NULL,
	"reason" text NOT NULL,
	"llm_raw" jsonb,
	"planned_at" timestamp with time zone NOT NULL,
	"applied_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "edge_recon_candidate_idx" ON "edge_reconciliation_log" USING btree ("candidate_from_knowledge_id","candidate_to_knowledge_id","candidate_relation_type");--> statement-breakpoint
CREATE INDEX "edge_recon_unapplied_idx" ON "edge_reconciliation_log" USING btree ("applied_at");