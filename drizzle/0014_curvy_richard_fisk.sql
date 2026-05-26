ALTER TABLE "tool_call_log" ADD COLUMN "effect" text;--> statement-breakpoint
ALTER TABLE "tool_call_log" ADD COLUMN "error_reason" text;--> statement-breakpoint
ALTER TABLE "tool_call_log" ADD COLUMN "mirrored_event_id" text;