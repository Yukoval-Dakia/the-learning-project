ALTER TABLE "event_subscription_checkpoint" ADD COLUMN "bootstrap_horizon_seq" bigint;--> statement-breakpoint
ALTER TABLE "event_subscription_checkpoint" ADD COLUMN "bootstrap_snapshot" text;
