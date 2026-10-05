DROP INDEX "tool_operation_running_process_idx";--> statement-breakpoint
ALTER TABLE "tool_operation" ADD COLUMN "owner_heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "tool_operation" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
UPDATE "tool_operation"
SET "owner_heartbeat_at" = now(), "lease_expires_at" = now() + interval '30 seconds'
WHERE "lease_expires_at" IS NULL;--> statement-breakpoint
ALTER TABLE "tool_operation" ALTER COLUMN "lease_expires_at" SET NOT NULL;--> statement-breakpoint
CREATE INDEX "tool_operation_running_lease_idx" ON "tool_operation" USING btree ("status","lease_expires_at");--> statement-breakpoint
ALTER TABLE "tool_operation" ADD CONSTRAINT "tool_operation_lease_timeline_ck" CHECK ("tool_operation"."owner_heartbeat_at" >= "tool_operation"."started_at"
        AND "tool_operation"."lease_expires_at" > "tool_operation"."owner_heartbeat_at");
