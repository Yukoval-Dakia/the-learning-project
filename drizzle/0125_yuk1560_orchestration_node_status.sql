ALTER TABLE "dag_orchestration_node" DROP CONSTRAINT "dag_orchestration_node_status_ck";
--> statement-breakpoint
ALTER TABLE "dag_orchestration_node" ADD CONSTRAINT "dag_orchestration_node_status_ck" CHECK ("dag_orchestration_node"."status" IN ('pending','enqueued','running','succeeded','failed','skipped','not_needed','degraded'));
